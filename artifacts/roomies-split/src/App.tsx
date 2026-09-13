import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useHealthCheck, useParseReceipt, type ParseReceiptMutationError } from '@workspace/api-client-react';
import {
  ArrowRight,
  CalendarDays,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Copy,
  FileImage,
  FilePlus2,
  History as HistoryIcon,
  IndianRupee,
  LoaderCircle,
  Pencil,
  Plus,
  ReceiptText,
  RotateCcw,
  ScanLine,
  Share2,
  Sparkles,
  Trash2,
  Upload,
  Users,
  WalletCards,
  X,
} from 'lucide-react';
import { Link, Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { calculateSplit } from '@/lib/split-engine';

type BillItem = {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  totalPrice: number;
  discount: number;
  tax: number;
  confidence: number;
};
type Person = { id: string; name: string; color: string };
type Allocation = { itemId: string; mode: 'equal' | 'percentage' | 'quantity'; personId: string; quantity: number; percentage: number };
type Adjustments = { subtotal: number; discount: number; cgst: number; sgst: number; igst: number; otherCharges: number; roundOff: number; grandTotal: number };
type Bill = { id: string; merchant: string; date: string; currency: string; items: BillItem[]; people: Person[]; adjustments: Adjustments; allocations: Allocation[]; payer: string; createdAt: string };
type BillStep = 'intake' | 'items' | 'people' | 'allocate' | 'summary' | 'settle';

const STORAGE_KEY = 'roomies-split-bills';
const DRAFT_KEY = 'roomies-split-draft';
const personColors = ['#0b7285', '#e8590c', '#7c3aed', '#2f9e44', '#c2255c', '#087f5b'];
const stepMeta: { key: BillStep; label: string }[] = [
  { key: 'intake', label: 'Start' },
  { key: 'items', label: 'Items' },
  { key: 'people', label: 'People' },
  { key: 'allocate', label: 'Split' },
  { key: 'summary', label: 'Review' },
  { key: 'settle', label: 'Done' },
];

const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
const numberValue = (value: string | number) => Number.isFinite(Number(value)) ? Number(value) : 0;
const money = (value: number, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value || 0);
const itemTotal = (item: BillItem) => item.totalPrice || Math.max(0, item.quantity * item.unitPrice - item.discount + item.tax);
const shortDate = (value: string) =>
  new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value));

const emptyAdjustments = (): Adjustments => ({ subtotal: 0, discount: 0, cgst: 0, sgst: 0, igst: 0, otherCharges: 0, roundOff: 0, grandTotal: 0 });
const makeItem = (name = ''): BillItem => ({ id: uid('item'), name, quantity: 1, unit: 'pcs', unitPrice: 0, totalPrice: 0, discount: 0, tax: 0, confidence: 1 });
const makePerson = (name: string, index: number): Person => ({ id: uid('person'), name, color: personColors[index % personColors.length] });
const equalAllocations = (items: BillItem[], people: Person[]): Allocation[] =>
  items.flatMap((item) => people.map((person) => ({ itemId: item.id, mode: 'equal' as const, personId: person.id, quantity: 1, percentage: people.length ? 100 / people.length : 0 })));
const initialBill = (): Bill => {
  const people = [makePerson('Me', 0), makePerson('Roomie', 1)];
  const items = [makeItem()];
  return { id: uid('bill'), merchant: '', date: new Date().toISOString().slice(0, 10), currency: 'INR', items, people, adjustments: emptyAdjustments(), allocations: equalAllocations(items, people), payer: people[0].id, createdAt: new Date().toISOString() };
};
const readBills = (): Bill[] => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as Bill[]; } catch { return []; }
};
const writeBills = (bills: Bill[]) => localStorage.setItem(STORAGE_KEY, JSON.stringify(bills));
const cloneBill = (bill: Bill): Bill => {
  const people = bill.people.map((person) => ({ ...person, id: uid('person') }));
  const itemIds = new Map(bill.items.map((item) => [item.id, uid('item')]));
  return { ...bill, id: uid('bill'), merchant: `${bill.merchant || 'Untitled bill'} copy`, createdAt: new Date().toISOString(), items: bill.items.map((item) => ({ ...item, id: itemIds.get(item.id)! })), people, allocations: bill.allocations.map((allocation) => ({ ...allocation, itemId: itemIds.get(allocation.itemId)!, personId: people[bill.people.findIndex((p) => p.id === allocation.personId)]?.id || people[0].id })) };
};

function Logo() {
  return (
    <Link href="/" className="focus-ring flex items-center gap-2" data-testid="link-logo">
      <span className="flex h-9 w-9 rotate-[-4deg] items-center justify-center rounded-[11px] bg-[hsl(var(--accent))] font-display text-lg font-bold text-[hsl(var(--accent-foreground))] shadow-[3px_3px_0_hsl(29_91%_39%)]">R</span>
      <span className="font-display text-lg font-bold tracking-[-.03em]">roomies<span className="text-[hsl(var(--accent))]">.</span></span>
    </Link>
  );
}

function Header() {
  const [location] = useLocation();
  const { data: health, isLoading: healthLoading, isError: healthError } = useHealthCheck();
  const nav = [
    { href: '/', label: 'New split', icon: FilePlus2 },
    { href: '/history', label: 'History', icon: HistoryIcon },
  ];
  return (
    <header className="relative z-10 border-b border-[hsl(var(--border))] bg-[hsl(var(--background)/.9)] backdrop-blur-md">
      <div className="mx-auto flex h-[4.5rem] max-w-6xl items-center justify-between px-4 sm:px-6">
        <Logo />
        <nav className="flex items-center gap-1" aria-label="Primary navigation">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className={`focus-ring flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold transition-colors ${location === href ? 'bg-[hsl(var(--secondary))] text-[hsl(var(--foreground))]' : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))]'}`} data-testid={`link-nav-${label.toLowerCase().replace(' ', '-')}`}>
              <Icon size={16} strokeWidth={2.2} /><span className="hidden sm:inline">{label}</span>
            </Link>
          ))}
          <div className="ml-2 hidden items-center gap-1.5 border-l border-[hsl(var(--border))] pl-3 text-[11px] font-semibold text-[hsl(var(--muted-foreground))] sm:flex" data-testid="status-api">
            <span className={`h-2 w-2 rounded-full ${healthError ? 'bg-[hsl(var(--destructive))]' : healthLoading ? 'animate-pulse-soft bg-[hsl(var(--accent))]' : 'bg-[#2f9e44]'}`} />
            {healthError ? 'offline mode' : healthLoading ? 'checking' : health?.status || 'ready'}
          </div>
        </nav>
      </div>
    </header>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="texture min-h-[100dvh] bg-[hsl(var(--background))]"><Header />{children}<footer className="mx-auto flex max-w-6xl items-center justify-between px-4 py-8 text-xs text-[hsl(var(--muted-foreground))] sm:px-6"><span>Roomies Split · built for real-life math</span><span className="flex items-center gap-1"><CircleHelp size={13} /> No account needed</span></footer></div>;
}

function HomePage() {
  const [bills] = useState<Bill[]>(readBills);
  const recent = bills.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3);
  return (
    <Shell>
      <main className="paper-grid mx-auto max-w-6xl px-4 pb-12 pt-8 sm:px-6 sm:pt-14">
        <section className="relative overflow-hidden rounded-[2rem] bg-[hsl(var(--primary))] px-6 py-10 text-[hsl(var(--primary-foreground))] shadow-[var(--shadow-lg)] sm:px-12 sm:py-14">
          <div className="absolute -right-12 -top-20 h-64 w-64 rounded-full border-[28px] border-[hsl(var(--accent)/.85)] opacity-90 sm:h-80 sm:w-80" />
          <div className="absolute bottom-[-5.5rem] right-28 h-44 w-44 rounded-full border-[18px] border-[hsl(var(--primary-foreground)/.1)]" />
          <div className="relative max-w-2xl animate-rise">
            <p className="mb-5 flex items-center gap-2 text-xs font-bold uppercase tracking-[.18em] text-[hsl(var(--accent))]"><Sparkles size={14} /> fair math, less awkwardness</p>
            <h1 className="font-display max-w-xl text-4xl font-bold leading-[.98] tracking-[-.06em] sm:text-6xl">A receipt in.<br /><span className="text-[hsl(var(--accent))]">Peace of mind out.</span></h1>
            <p className="mt-6 max-w-md text-base leading-7 text-[hsl(var(--primary-foreground)/.76)] sm:text-lg">Split groceries, dinners, and rent runs in about a minute. No accounts. No spreadsheet archaeology.</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href="/bill/new" className="btn-primary w-full bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))] shadow-[0_5px_0_hsl(29_91%_39%)] sm:w-auto" data-testid="link-start-manual"><FilePlus2 size={18} /> Start a bill <ArrowRight size={17} /></Link>
              <Link href="/bill/new" className="btn-secondary w-full border-[hsl(var(--primary-foreground)/.2)] bg-[hsl(var(--primary-foreground)/.1)] text-[hsl(var(--primary-foreground))] sm:w-auto" data-testid="link-start-receipt"><Camera size={18} /> Scan a receipt</Link>
            </div>
          </div>
          <div className="relative mt-12 hidden max-w-sm rotate-2 rounded-xl border border-[hsl(var(--primary-foreground)/.16)] bg-[hsl(var(--primary-foreground)/.08)] p-5 shadow-2xl sm:absolute sm:bottom-12 sm:right-12 sm:mt-0 sm:block">
            <div className="mb-4 flex items-center justify-between text-xs text-[hsl(var(--primary-foreground)/.55)]"><span>THURSDAY DINNER</span><span>8:42 PM</span></div>
            <div className="space-y-3">
              {['Paneer tikka', 'Garlic naan', 'Mango lassi'].map((item, index) => <div key={item} className="flex justify-between border-b border-[hsl(var(--primary-foreground)/.12)] pb-2 text-sm"><span>{item}</span><span className="font-semibold">{money([360, 120, 180][index])}</span></div>)}
            </div>
            <div className="mt-4 flex items-end justify-between"><span className="text-xs text-[hsl(var(--primary-foreground)/.55)]">3 friends · fair split</span><span className="font-display text-2xl font-bold text-[hsl(var(--accent))]">{money(220)}</span></div>
          </div>
        </section>

        <section className="mt-10 grid gap-4 sm:grid-cols-3">
          {[
            { number: '01', title: 'Bring the bill', text: 'Snap a receipt or type the few things that matter.', icon: ReceiptText },
            { number: '02', title: 'Make it fair', text: 'Add people and tap who had what. Extras stay visible.', icon: Users },
            { number: '03', title: 'Settle up', text: 'See the clean totals and share the result anywhere.', icon: WalletCards },
          ].map(({ number, title, text, icon: Icon }, index) => <article key={number} className={`card-shell animate-rise-delay p-5 ${index === 1 ? 'bg-[hsl(var(--secondary)/.56)]' : ''}`}><div className="mb-7 flex items-center justify-between"><span className="font-mono text-xs font-bold text-[hsl(var(--accent))]">{number}</span><Icon size={20} className="text-[hsl(var(--primary))]" /></div><h2 className="font-display text-lg font-bold">{title}</h2><p className="mt-2 text-sm leading-6 text-[hsl(var(--muted-foreground))]">{text}</p></article>)}
        </section>

        <section className="mt-12">
          <div className="mb-4 flex items-end justify-between"><div><p className="text-xs font-bold uppercase tracking-[.16em] text-[hsl(var(--accent))]">local, private, handy</p><h2 className="mt-1 font-display text-2xl font-bold tracking-[-.04em]">Your recent splits</h2></div>{recent.length > 0 && <Link href="/history" className="focus-ring text-sm font-bold text-[hsl(var(--primary))]" data-testid="link-see-history">See all <ArrowRight className="ml-1 inline" size={14} /></Link>}</div>
          {recent.length === 0 ? <div className="dotted-card flex flex-col items-center justify-center px-6 py-12 text-center"><div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><HistoryIcon size={22} /></div><h3 className="font-display font-bold">Your split shelf is empty</h3><p className="mt-1 max-w-xs text-sm text-[hsl(var(--muted-foreground))]">Finish your first bill and it will stay here on this device.</p></div> : <div className="grid gap-3 sm:grid-cols-3">{recent.map((bill) => <Link key={bill.id} href="/history" className="card-shell group p-4 transition-transform hover:-translate-y-1" data-testid={`card-recent-${bill.id}`}><div className="flex items-start justify-between"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><ReceiptText size={17} /></span><span className="text-xs text-[hsl(var(--muted-foreground))]">{shortDate(bill.date)}</span></div><p className="mt-4 truncate font-display font-bold">{bill.merchant || 'Untitled bill'}</p><div className="mt-1 flex justify-between text-sm text-[hsl(var(--muted-foreground))]"><span>{bill.people.length} people</span><span className="font-bold text-[hsl(var(--foreground))]">{money(bill.adjustments.grandTotal, bill.currency)}</span></div></Link>)}</div>}
        </section>
      </main>
    </Shell>
  );
}

function Stepper({ step, setStep }: { step: BillStep; setStep: (step: BillStep) => void }) {
  const current = stepMeta.findIndex((item) => item.key === step);
  return <div className="mb-8 overflow-x-auto pb-1"><div className="flex min-w-[490px] items-center">{stepMeta.map((item, index) => <div key={item.key} className="flex flex-1 items-center"><button type="button" onClick={() => index <= current && setStep(item.key)} className={`focus-ring flex items-center gap-2 text-left text-xs font-bold ${index <= current ? 'text-[hsl(var(--primary))]' : 'text-[hsl(var(--muted-foreground))]'}`} data-testid={`button-step-${item.key}`}><span className={`flex h-7 w-7 items-center justify-center rounded-full border-2 text-[11px] ${index < current ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : index === current ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))]' : 'border-[hsl(var(--border))] bg-[hsl(var(--card))]'}`}>{index < current ? <Check size={14} /> : index + 1}</span><span>{item.label}</span></button>{index < stepMeta.length - 1 && <span className={`mx-2 h-px flex-1 ${index < current ? 'bg-[hsl(var(--primary))]' : 'bg-[hsl(var(--border))]'}`} />}</div>)}</div></div>;
}

function BillPage() {
  const [, setLocation] = useLocation();
  const [bill, setBill] = useState<Bill>(() => {
    try { const draft = localStorage.getItem(DRAFT_KEY); return draft ? JSON.parse(draft) as Bill : initialBill(); } catch { return initialBill(); }
  });
  const [step, setStep] = useState<BillStep>('intake');
  const [receiptImages, setReceiptImages] = useState<{ dataUrl: string; filename?: string }[]>([]);
  const [parseMessage, setParseMessage] = useState('');
  const [notice, setNotice] = useState('');
  const parseReceipt = useParseReceipt();
  const fileRef = useRef<HTMLInputElement>(null);

  const totals = useMemo(
    () => calculateSplit(bill.items, bill.people, bill.allocations, bill.adjustments),
    [bill],
  );

  const updateItem = (id: string, patch: Partial<BillItem>) => setBill((current) => ({ ...current, items: current.items.map((item) => item.id === id ? { ...item, ...patch, totalPrice: patch.totalPrice ?? Math.max(0, (patch.quantity ?? item.quantity) * (patch.unitPrice ?? item.unitPrice) - (patch.discount ?? item.discount) + (patch.tax ?? item.tax)) } : item) }));
  const addItem = () => setBill((current) => { const item = makeItem(); return { ...current, items: [...current.items, item], allocations: [...current.allocations, ...equalAllocations([item], current.people)] }; });
  const removeItem = (id: string) => setBill((current) => ({ ...current, items: current.items.filter((item) => item.id !== id), allocations: current.allocations.filter((allocation) => allocation.itemId !== id) }));
  const addPerson = () => setBill((current) => { const person = makePerson(`Person ${current.people.length + 1}`, current.people.length); return { ...current, people: [...current.people, person], allocations: [...current.allocations, ...equalAllocations(current.items, [person])] }; });
  const removePerson = (id: string) => setBill((current) => { const people = current.people.filter((person) => person.id !== id); const allocations = current.allocations.filter((allocation) => allocation.personId !== id); return { ...current, people: people.length ? people : [makePerson('Me', 0)], payer: current.payer === id ? (people[0]?.id || current.payer) : current.payer, allocations }; });
  const toggleAllocation = (itemId: string, personId: string) => setBill((current) => {
    const existing = current.allocations.filter((allocation) => allocation.itemId === itemId);
    const currentMode = existing[0]?.mode ?? 'equal';
    const has = existing.some((allocation) => allocation.personId === personId);
    const nextPeople = has
      ? existing.filter((allocation) => allocation.personId !== personId)
      : [...existing, { itemId, personId, mode: currentMode, quantity: 1, percentage: 0 }];
    // Only 'equal' mode recomputes an even split automatically; percentage/quantity
    // allocations are user-entered and must not be clobbered when membership changes.
    const settled = currentMode === 'equal'
      ? nextPeople.map((allocation) => ({ ...allocation, percentage: nextPeople.length ? 100 / nextPeople.length : 0 }))
      : nextPeople;
    const allocations = [...current.allocations.filter((allocation) => allocation.itemId !== itemId), ...settled];
    return { ...current, allocations };
  });
  const setAllocationMode = (itemId: string, mode: Allocation['mode']) => setBill((current) => ({
    ...current,
    allocations: current.allocations.map((allocation) =>
      allocation.itemId === itemId ? { ...allocation, mode } : allocation,
    ),
  }));
  const updateAllocation = (itemId: string, personId: string, patch: Partial<Allocation>) => setBill((current) => ({
    ...current,
    allocations: current.allocations.map((allocation) =>
      allocation.itemId === itemId && allocation.personId === personId
        ? { ...allocation, ...patch }
        : allocation,
    ),
  }));
  const updateAdjustments = (key: keyof Adjustments, value: string) => setBill((current) => ({ ...current, adjustments: { ...current.adjustments, [key]: numberValue(value) } }));
  const next = () => setStep((current) => stepMeta[Math.min(stepMeta.length - 1, stepMeta.findIndex((item) => item.key === current) + 1)].key);
  const back = () => setStep((current) => stepMeta[Math.max(0, stepMeta.findIndex((item) => item.key === current) - 1)].key);

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const imageFiles = Array.from(files).slice(0, 8).filter((file) => file.type.startsWith('image/'));
    const encoded = await Promise.all(imageFiles.map((file) => new Promise<{ dataUrl: string; filename: string }>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({ dataUrl: String(reader.result), filename: file.name }); reader.onerror = reject; reader.readAsDataURL(file); })));
    setReceiptImages(encoded);
    setParseMessage(`${encoded.length} receipt ${encoded.length === 1 ? 'image' : 'images'} ready`);
  };
  const removeReceiptImage = (filename?: string) => {
    setReceiptImages((current) => current.filter((image) => image.filename !== filename));
  };
  const parseImages = () => {
    if (!receiptImages.length) { setParseMessage('Add a receipt image first.'); return; }
    setParseMessage('');
    parseReceipt.mutate({ data: { images: receiptImages } }, {
      onSuccess: (result) => {
        const items = result.items.map((item) => ({ ...item, id: item.id || uid('item') }));
        const people = bill.people.length ? bill.people : [makePerson('Me', 0)];
        setBill((current) => ({ ...current, merchant: result.merchant || current.merchant, date: result.date || current.date, currency: result.currency || current.currency, items: items.length ? items : current.items, adjustments: { ...current.adjustments, subtotal: result.subtotal ?? current.adjustments.subtotal, discount: result.discount, cgst: result.cgst, sgst: result.sgst, igst: result.igst, otherCharges: result.otherCharges, roundOff: result.roundOff, grandTotal: result.grandTotal ?? current.adjustments.grandTotal }, allocations: equalAllocations(items.length ? items : current.items, people) }));
        setParseMessage(result.warnings?.length ? result.warnings.join(' · ') : 'Receipt read. Give the items a quick look.');
        setStep('items');
      },
      onError: (error: ParseReceiptMutationError) => {
        const serverMessage = error?.data?.error;
        setParseMessage(
          serverMessage
            ? `${serverMessage} Nothing was lost — add the items manually below.`
            : 'We could not read that receipt. Nothing was lost — add the items manually below.',
        );
      },
    });
  };
  const persist = (goToHistory = false) => {
    const completed = { ...bill, adjustments: { ...bill.adjustments, subtotal: totals.subtotal, grandTotal: totals.grandTotal } };
    const bills = readBills().filter((entry) => entry.id !== bill.id);
    writeBills([completed, ...bills]);
    localStorage.removeItem(DRAFT_KEY);
    setBill(completed);
    setNotice('Saved on this device');
    if (goToHistory) setLocation('/history');
  };
  const share = async () => {
    const text = `${bill.merchant || 'Roomies bill'} · ${money(totals.grandTotal, bill.currency)}\n${totals.shares.map(({ person, amount }) => `${person.name}: ${money(amount, bill.currency)}`).join('\n')}`;
    try {
      if (navigator.share) await navigator.share({ title: bill.merchant || 'Roomies split', text });
      else { await navigator.clipboard.writeText(text); setNotice('Split copied to clipboard'); }
    } catch { setNotice('Sharing cancelled'); }
  };

  return (
    <Shell>
      <main className="mx-auto max-w-5xl px-4 pb-16 pt-8 sm:px-6 sm:pt-12">
        <div className="mb-7 flex items-center justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.16em] text-[hsl(var(--accent))]">new split</p><h1 className="mt-1 font-display text-3xl font-bold tracking-[-.05em] sm:text-4xl">{bill.merchant || 'Untitled bill'}</h1></div><Link href="/" className="btn-ghost" data-testid="link-cancel-bill"><X size={17} /> <span className="hidden sm:inline">Exit</span></Link></div>
        <Stepper step={step} setStep={setStep} />
        {notice && <div className="mb-5 flex items-center gap-2 rounded-xl bg-[hsl(141_40%_91%)] px-4 py-3 text-sm font-semibold text-[hsl(151_55%_25%)]" data-testid="status-notice"><Check size={16} />{notice}</div>}
        {step === 'intake' && <IntakeStep bill={bill} setBill={setBill} receiptImages={receiptImages} fileRef={fileRef} handleFiles={handleFiles} removeReceiptImage={removeReceiptImage} parseImages={parseImages} parseReceipt={parseReceipt} parseMessage={parseMessage} />}
        {step === 'items' && <ItemsStep bill={bill} updateItem={updateItem} addItem={addItem} removeItem={removeItem} />}
        {step === 'people' && <PeopleStep bill={bill} setBill={setBill} addPerson={addPerson} removePerson={removePerson} />}
         {step === 'allocate' && <AllocateStep bill={bill} totals={totals} toggleAllocation={toggleAllocation} setAllocationMode={setAllocationMode} updateAllocation={updateAllocation} />}
        {step === 'summary' && <SummaryStep bill={bill} totals={totals} updateAdjustments={updateAdjustments} />}
        {step === 'settle' && <SettleStep bill={bill} totals={totals} share={share} persist={persist} />}
        <div className="mobile-sticky-bottom mt-8 flex items-center justify-between gap-3 rounded-2xl bg-[hsl(var(--background)/.9)] py-2 backdrop-blur sm:static sm:bg-transparent sm:py-0">
          <button type="button" className="btn-ghost" onClick={back} disabled={step === 'intake'} data-testid="button-step-back"><ChevronLeft size={17} /> Back</button>
          {step !== 'settle' ? <button type="button" className="btn-primary" onClick={next} data-testid="button-step-next">{step === 'summary' ? 'See settlement' : 'Continue'} <ChevronRight size={17} /></button> : <button type="button" className="btn-secondary" onClick={() => persist(true)} data-testid="button-finish-history"><Check size={17} /> Save & finish</button>}
        </div>
      </main>
    </Shell>
  );
}

function IntakeStep({ bill, setBill, receiptImages, fileRef, handleFiles, removeReceiptImage, parseImages, parseReceipt, parseMessage }: { bill: Bill; setBill: React.Dispatch<React.SetStateAction<Bill>>; receiptImages: { dataUrl: string; filename?: string }[]; fileRef: React.RefObject<HTMLInputElement | null>; handleFiles: (files: FileList | null) => void; removeReceiptImage: (filename?: string) => void; parseImages: () => void; parseReceipt: ReturnType<typeof useParseReceipt>; parseMessage: string }) {
  return <section className="animate-rise grid gap-5 lg:grid-cols-[1.1fr_.9fr]">
    <div className="card-shell p-5 sm:p-7">
      <div className="mb-6 flex items-start justify-between"><div><p className="text-xs font-bold uppercase tracking-[.15em] text-[hsl(var(--accent))]">first, the basics</p><h2 className="mt-1 font-display text-2xl font-bold">What are we splitting?</h2></div><span className="rounded-full bg-[hsl(var(--secondary))] px-3 py-1 text-xs font-bold text-[hsl(var(--primary))]">1 min</span></div>
      <div className="space-y-4">
        <label className="block text-sm font-bold">Merchant or occasion<input className="input-shell mt-2" value={bill.merchant} onChange={(event) => setBill((current) => ({ ...current, merchant: event.target.value }))} placeholder="e.g. Fresh Basket, Friday dinner" data-testid="input-merchant" /></label>
        <div className="grid gap-4 sm:grid-cols-2"><label className="block text-sm font-bold">Date<div className="relative mt-2"><CalendarDays className="pointer-events-none absolute left-3 top-3 text-[hsl(var(--muted-foreground))]" size={16} /><input type="date" className="input-shell pl-10" value={bill.date} onChange={(event) => setBill((current) => ({ ...current, date: event.target.value }))} data-testid="input-date" /></div></label><label className="block text-sm font-bold">Currency<select className="input-shell mt-2" value={bill.currency} onChange={(event) => setBill((current) => ({ ...current, currency: event.target.value }))} data-testid="select-currency"><option value="INR">INR · Indian Rupee</option><option value="USD">USD · US Dollar</option><option value="EUR">EUR · Euro</option></select></label></div>
      </div>
      <div className="mt-7 border-t border-[hsl(var(--border))] pt-5"><p className="mb-3 text-xs font-bold uppercase tracking-[.14em] text-[hsl(var(--muted-foreground))]">or start with a blank slate</p><button type="button" className="btn-secondary" onClick={() => setBill((current) => ({ ...current, items: current.items.length === 1 && !current.items[0].name ? [makeItem('Dinner')] : current.items }))} data-testid="button-start-manual"><FilePlus2 size={17} /> Add items manually</button></div>
    </div>
     <div className="dotted-card p-5 sm:p-7" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); handleFiles(event.dataTransfer.files); }}>
      <div className="flex h-full flex-col"><div><div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))]"><ScanLine size={24} /></div><h2 className="font-display text-2xl font-bold">Have a receipt?</h2><p className="mt-2 max-w-sm text-sm leading-6 text-[hsl(var(--muted-foreground))]">Add a photo and we’ll pull out the line items. You review everything before it counts.</p></div>
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => handleFiles(event.target.files)} data-testid="input-receipt-file" />
         <div className="mt-6 flex flex-wrap gap-2">{receiptImages.map((image) => <span key={image.filename} className="flex items-center gap-2 rounded-lg bg-[hsl(var(--card))] px-3 py-2 text-xs font-semibold shadow-sm"><FileImage size={14} className="text-[hsl(var(--primary))]" />{image.filename}<button type="button" className="focus-ring rounded p-0.5 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))]" onClick={() => removeReceiptImage(image.filename)} aria-label={`Remove ${image.filename}`} data-testid={`button-remove-receipt-${image.filename}`}><X size={13} /></button></span>)}</div>
         <p className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">Drop up to 8 clear photos here, or choose from your device.</p>
        {parseMessage && <p className="mt-4 rounded-xl bg-[hsl(var(--card))] px-3 py-2 text-xs font-semibold leading-5 text-[hsl(var(--primary))]" data-testid="status-parse-message">{parseMessage}</p>}
        {parseReceipt.isError && <div className="mt-4 flex items-center gap-2 text-sm text-[hsl(var(--destructive))]" data-testid="status-parse-error"><RotateCcw size={15} /> Try another clear photo, or continue manually.</div>}
        <div className="mt-auto flex flex-col gap-2 pt-8 sm:flex-row"><button type="button" className="btn-secondary" onClick={() => fileRef.current?.click()} data-testid="button-upload-receipt"><Upload size={17} /> Choose photo</button><button type="button" className="btn-primary" disabled={parseReceipt.isPending || !receiptImages.length} onClick={parseImages} data-testid="button-parse-receipt">{parseReceipt.isPending ? <><LoaderCircle className="animate-spin" size={17} /> Reading receipt</> : <><Sparkles size={17} /> Read receipt</>}</button></div>
      </div>
    </div>
  </section>;
}

function ItemsStep({ bill, updateItem, addItem, removeItem }: { bill: Bill; updateItem: (id: string, patch: Partial<BillItem>) => void; addItem: () => void; removeItem: (id: string) => void }) {
  return <section className="card-shell animate-rise p-5 sm:p-7"><div className="mb-6 flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.15em] text-[hsl(var(--accent))]">check the extraction</p><h2 className="mt-1 font-display text-2xl font-bold">What’s on the bill?</h2><p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">Correct anything that looks off. The math updates as you type.</p></div><button type="button" className="btn-secondary shrink-0" onClick={addItem} data-testid="button-add-item"><Plus size={17} /> <span className="hidden sm:inline">Add item</span></button></div>
    <div className="space-y-3">{bill.items.map((item, index) => <div key={item.id} className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background)/.5)] p-3 sm:p-4" data-testid={`row-item-${item.id}`}><div className="grid gap-3 sm:grid-cols-[1fr_75px_110px_110px_auto] sm:items-end"><label className="text-xs font-bold text-[hsl(var(--muted-foreground))]">Item {index + 1}<input className="input-shell mt-1.5" value={item.name} onChange={(event) => updateItem(item.id, { name: event.target.value })} placeholder="e.g. Dal makhani" data-testid={`input-item-name-${item.id}`} /></label><label className="text-xs font-bold text-[hsl(var(--muted-foreground))]">Qty<input type="number" min="0" step=".25" className="input-shell mt-1.5" value={item.quantity} onChange={(event) => updateItem(item.id, { quantity: numberValue(event.target.value) })} data-testid={`input-item-quantity-${item.id}`} /></label><label className="text-xs font-bold text-[hsl(var(--muted-foreground))]">Unit price<input type="number" min="0" step=".01" className="input-shell mt-1.5" value={item.unitPrice} onChange={(event) => updateItem(item.id, { unitPrice: numberValue(event.target.value) })} data-testid={`input-item-price-${item.id}`} /></label><label className="text-xs font-bold text-[hsl(var(--muted-foreground))]">Discount<input type="number" min="0" step=".01" className="input-shell mt-1.5" value={item.discount} onChange={(event) => updateItem(item.id, { discount: numberValue(event.target.value) })} data-testid={`input-item-discount-${item.id}`} /></label><button type="button" className="btn-ghost min-h-11 !px-3 text-[hsl(var(--destructive))]" onClick={() => removeItem(item.id)} disabled={bill.items.length === 1} aria-label={`Delete ${item.name || 'item'}`} data-testid={`button-delete-item-${item.id}`}><Trash2 size={17} /></button></div><div className="mt-2 flex items-center justify-between text-xs text-[hsl(var(--muted-foreground))]"><span>{item.confidence < .75 ? 'Worth a quick check' : 'Looks confident'}{item.confidence < .75 && <span className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--accent))]" />}</span><span className="font-display text-sm font-bold text-[hsl(var(--foreground))]">{money(Math.max(0, item.quantity * item.unitPrice - item.discount), bill.currency)}</span></div></div>)}</div>
  </section>;
}

function PeopleStep({ bill, setBill, addPerson, removePerson }: { bill: Bill; setBill: React.Dispatch<React.SetStateAction<Bill>>; addPerson: () => void; removePerson: (id: string) => void }) {
  return <section className="animate-rise grid gap-5 lg:grid-cols-[1fr_300px]"><div className="card-shell p-5 sm:p-7"><div className="mb-6 flex items-start justify-between"><div><p className="text-xs font-bold uppercase tracking-[.15em] text-[hsl(var(--accent))]">make it personal</p><h2 className="mt-1 font-display text-2xl font-bold">Who’s in?</h2><p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">Names make the final message much easier to understand.</p></div><button type="button" className="btn-secondary" onClick={addPerson} data-testid="button-add-person"><Plus size={17} /> Add</button></div><div className="space-y-3">{bill.people.map((person, index) => <div key={person.id} className="flex items-center gap-3 rounded-xl border border-[hsl(var(--border))] p-3" data-testid={`row-person-${person.id}`}><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full font-display font-bold text-[hsl(var(--primary-foreground))]" style={{ backgroundColor: person.color }}>{person.name.slice(0, 1).toUpperCase() || '?'}</span><input className="input-shell" value={person.name} onChange={(event) => setBill((current) => ({ ...current, people: current.people.map((entry) => entry.id === person.id ? { ...entry, name: event.target.value } : entry) }))} aria-label={`Person ${index + 1} name`} data-testid={`input-person-name-${person.id}`} /><button type="button" className="btn-ghost text-[hsl(var(--destructive))]" onClick={() => removePerson(person.id)} disabled={bill.people.length === 1} aria-label={`Remove ${person.name}`} data-testid={`button-delete-person-${person.id}`}><Trash2 size={16} /></button></div>)}</div></div><aside className="rounded-[1.25rem] bg-[hsl(var(--primary))] p-6 text-[hsl(var(--primary-foreground))]"><Users size={24} className="text-[hsl(var(--accent))]" /><p className="mt-8 font-display text-3xl font-bold">{bill.people.length}</p><p className="mt-1 text-sm text-[hsl(var(--primary-foreground)/.72)]">people on this bill</p><label className="mt-7 block text-xs font-bold text-[hsl(var(--primary-foreground)/.72)]">Who paid?<select className="input-shell mt-2 bg-[hsl(var(--primary-foreground)/.1)] text-[hsl(var(--primary-foreground))]" value={bill.payer} onChange={(event) => setBill((current) => ({ ...current, payer: event.target.value }))} data-testid="select-payer">{bill.people.map((person) => <option key={person.id} value={person.id} className="text-[hsl(var(--foreground))]">{person.name}</option>)}</select></label><p className="mt-7 text-sm leading-6 text-[hsl(var(--primary-foreground)/.72)]">You can always come back and change the split before saving.</p></aside></section>;
}

function AllocateStep({ bill, totals, toggleAllocation, setAllocationMode, updateAllocation }: { bill: Bill; totals: { subtotal: number; grandTotal: number; shares: { person: Person; amount: number }[] }; toggleAllocation: (itemId: string, personId: string) => void; setAllocationMode: (itemId: string, mode: Allocation['mode']) => void; updateAllocation: (itemId: string, personId: string, patch: Partial<Allocation>) => void }) {
  return <section className="animate-rise"><div className="mb-6"><p className="text-xs font-bold uppercase tracking-[.15em] text-[hsl(var(--accent))]">tap to include</p><h2 className="mt-1 font-display text-2xl font-bold">Who had what?</h2><p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">Choose equal, percentage, or quantity allocation for each line.</p></div><div className="space-y-3">{bill.items.map((item) => { const itemAllocations = bill.allocations.filter((allocation) => allocation.itemId === item.id); const selected = itemAllocations.map((allocation) => allocation.personId); const mode = itemAllocations[0]?.mode || 'equal'; const allocatedQuantity = itemAllocations.reduce((sum, allocation) => sum + (mode === 'quantity' ? allocation.quantity : 0), 0); const allocatedPercentage = itemAllocations.reduce((sum, allocation) => sum + (mode === 'percentage' ? allocation.percentage : 0), 0); const remaining = mode === 'quantity' ? item.quantity - allocatedQuantity : 100 - allocatedPercentage; return <div key={item.id} className="card-shell p-4 sm:p-5" data-testid={`card-allocation-${item.id}`}><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-display font-bold">{item.name || 'Unnamed item'}</h3><p className="text-sm text-[hsl(var(--muted-foreground))]">{money(itemTotal(item), bill.currency)} · {item.quantity} {item.unit}</p></div><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${remaining < -0.001 ? 'bg-[hsl(var(--destructive)/.12)] text-[hsl(var(--destructive))]' : 'bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]'}`}>{mode === 'quantity' ? `${remaining.toFixed(2)} ${item.unit} left` : `${remaining.toFixed(2)}% left`}</span></div><div className="mt-4 flex flex-wrap gap-2">{(['equal', 'percentage', 'quantity'] as const).map((option) => <button key={option} type="button" onClick={() => setAllocationMode(item.id, option)} className={`focus-ring rounded-full border px-3 py-2 text-xs font-bold ${mode === option ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'border-[hsl(var(--border))] bg-[hsl(var(--card))] text-[hsl(var(--muted-foreground))]'}`} data-testid={`button-mode-${item.id}-${option}`}>{option === 'equal' ? 'Equal split' : option === 'percentage' ? 'Percent' : 'Custom quantity'}</button>)}<button type="button" className="btn-ghost !min-h-9 !px-3 text-xs" onClick={() => { bill.people.forEach((person) => { if (!selected.includes(person.id)) toggleAllocation(item.id, person.id); }); }} data-testid={`button-everyone-${item.id}`}>Everyone</button></div><div className="mt-4 flex flex-wrap gap-2">{bill.people.map((person) => { const allocation = itemAllocations.find((entry) => entry.personId === person.id); const isSelected = Boolean(allocation); return <div key={person.id} className="flex items-center gap-2">{<button type="button" onClick={() => toggleAllocation(item.id, person.id)} className={`focus-ring flex items-center gap-2 rounded-full border px-3 py-2 text-sm font-bold ${isSelected ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'border-[hsl(var(--border))] bg-[hsl(var(--card))] text-[hsl(var(--muted-foreground))]'}`} data-testid={`button-allocate-${item.id}-${person.id}`}><span className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] text-white" style={{ backgroundColor: person.color }}>{person.name.slice(0, 1)}</span>{person.name}{isSelected && <Check size={14} />}</button>}{allocation && mode !== 'equal' && <input aria-label={`${person.name} ${mode} for ${item.name}`} type="number" min="0" max={mode === 'quantity' ? item.quantity : 100} step={mode === 'quantity' ? '.25' : '1'} value={mode === 'quantity' ? allocation.quantity : allocation.percentage} onChange={(event) => updateAllocation(item.id, person.id, mode === 'quantity' ? { quantity: numberValue(event.target.value) } : { percentage: numberValue(event.target.value) })} className="input-shell w-24" data-testid={`input-allocation-${item.id}-${person.id}`} />}</div>; })}</div>{remaining < -0.001 || (mode === 'quantity' && Math.abs(remaining) > 0.001) || (mode === 'percentage' && Math.abs(remaining) > 0.001) ? <p className={`mt-3 text-xs font-bold ${remaining < -0.001 ? 'text-[hsl(var(--destructive))]' : 'text-[hsl(var(--accent-foreground))]'}`} role="status">{remaining < -0.001 ? `${Math.abs(remaining).toFixed(2)} ${mode === 'quantity' ? item.unit : '%'} over-allocated` : `${remaining.toFixed(2)} ${mode === 'quantity' ? item.unit : '%'} still unassigned`}</p> : null}</div>; })}</div><div className="mt-6 grid gap-3 sm:grid-cols-3">{totals.shares.map(({ person, amount }) => <div key={person.id} className="card-shell flex items-center justify-between p-4" data-testid={`summary-share-${person.id}`}><div className="flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{ backgroundColor: person.color }} /><span className="text-sm font-semibold">{person.name}</span></div><span className="font-display font-bold">{money(amount, bill.currency)}</span></div>)}</div></section>;
}

function SummaryStep({ bill, totals, updateAdjustments }: { bill: Bill; totals: { subtotal: number; grandTotal: number; shares: { person: Person; amount: number }[] }; updateAdjustments: (key: keyof Adjustments, value: string) => void }) {
  const adjustmentFields: { key: keyof Adjustments; label: string }[] = [{ key: 'discount', label: 'Discount' }, { key: 'cgst', label: 'CGST' }, { key: 'sgst', label: 'SGST' }, { key: 'igst', label: 'IGST' }, { key: 'otherCharges', label: 'Other charges' }, { key: 'roundOff', label: 'Round off' }];
  const receiptDifference = bill.adjustments.grandTotal > 0 ? bill.adjustments.grandTotal - totals.grandTotal : 0;
  return <section className="animate-rise grid gap-5 lg:grid-cols-[1.05fr_.95fr]"><div className="card-shell p-5 sm:p-7"><div className="mb-6"><p className="text-xs font-bold uppercase tracking-[.15em] text-[hsl(var(--accent))]">the clean version</p><h2 className="mt-1 font-display text-2xl font-bold">Review the math</h2></div><div className="space-y-3">{bill.items.map((item) => <div className="flex items-center justify-between text-sm" key={item.id}><span className="text-[hsl(var(--muted-foreground))]">{item.name || 'Unnamed item'}</span><span className="font-semibold">{money(itemTotal(item), bill.currency)}</span></div>)}</div><div className="my-5 border-t border-[hsl(var(--border))]" /><div className="grid grid-cols-2 gap-3">{adjustmentFields.map(({ key, label }) => <label key={key} className="text-xs font-bold text-[hsl(var(--muted-foreground))]">{label}<div className="relative mt-1.5"><IndianRupee className="pointer-events-none absolute left-2.5 top-3 text-[hsl(var(--muted-foreground))]" size={14} /><input type="number" step=".01" className="input-shell pl-8" value={bill.adjustments[key]} onChange={(event) => updateAdjustments(key, event.target.value)} data-testid={`input-adjustment-${key}`} /></div></label>)}</div>{Math.abs(receiptDifference) > 0.01 && <div className="mt-5 rounded-xl border border-[hsl(var(--accent)/.35)] bg-[hsl(var(--accent)/.12)] p-3 text-sm" role="status"><strong>Check the total:</strong> receipt says {money(bill.adjustments.grandTotal, bill.currency)}, while the current items and adjustments add to {money(totals.grandTotal, bill.currency)}. Difference: {money(Math.abs(receiptDifference), bill.currency)}.</div>}</div><div className="space-y-5"><div className="rounded-[1.25rem] bg-[hsl(var(--primary))] p-6 text-[hsl(var(--primary-foreground))]"><p className="text-xs font-bold uppercase tracking-[.15em] text-[hsl(var(--primary-foreground)/.6)]">grand total</p><p className="mt-2 font-display text-5xl font-bold tracking-[-.06em]" data-testid="text-grand-total">{money(totals.grandTotal, bill.currency)}</p><div className="mt-5 flex justify-between border-t border-[hsl(var(--primary-foreground)/.15)] pt-4 text-sm"><span>Subtotal</span><span>{money(totals.subtotal, bill.currency)}</span></div></div><div className="card-shell p-5"><h3 className="font-display font-bold">Everyone’s share</h3><div className="mt-4 space-y-3">{totals.shares.map(({ person, amount }) => <div className="flex items-center justify-between" key={person.id}><div className="flex items-center gap-2 text-sm"><span className="h-3 w-3 rounded-full" style={{ backgroundColor: person.color }} />{person.name}</div><span className="font-display font-bold">{money(amount, bill.currency)}</span></div>)}</div></div></div></section>;
}

function SettleStep({ bill, totals, share, persist }: { bill: Bill; totals: { subtotal: number; grandTotal: number; shares: { person: Person; amount: number }[] }; share: () => void; persist: (goToHistory?: boolean) => void }) {
  return <section className="animate-rise mx-auto max-w-2xl"><div className="rounded-[2rem] bg-[hsl(var(--primary))] p-6 text-[hsl(var(--primary-foreground))] shadow-[var(--shadow-lg)] sm:p-10"><div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))]"><Check size={28} strokeWidth={3} /></div><p className="mt-8 text-xs font-bold uppercase tracking-[.18em] text-[hsl(var(--accent))]">split complete</p><h2 className="mt-2 font-display text-4xl font-bold tracking-[-.06em]">That’s the whole story.</h2><p className="mt-3 text-[hsl(var(--primary-foreground)/.72)]">{bill.merchant || 'This bill'} comes to <strong className="text-[hsl(var(--primary-foreground))]">{money(totals.grandTotal, bill.currency)}</strong>.</p><div className="mt-8 overflow-hidden rounded-xl border border-[hsl(var(--primary-foreground)/.16)]"><div className="divide-y divide-[hsl(var(--primary-foreground)/.12)]">{totals.shares.map(({ person, amount }) => <div key={person.id} className="flex items-center justify-between px-4 py-3"><div className="flex items-center gap-2 text-sm"><span className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold text-white" style={{ backgroundColor: person.color }}>{person.name.slice(0, 1)}</span>{person.name}{person.id === bill.payer && <span className="rounded-full bg-[hsl(var(--primary-foreground)/.12)] px-2 py-0.5 text-[10px] font-bold">paid</span>}</div><span className="font-display font-bold">{money(amount, bill.currency)}</span></div>)}</div></div><div className="mt-7 flex flex-col gap-3 sm:flex-row"><button type="button" className="btn-primary flex-1 bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))] shadow-[0_5px_0_hsl(29_91%_39%)]" onClick={share} data-testid="button-share-split"><Share2 size={17} /> Share split</button><button type="button" className="btn-secondary flex-1 border-[hsl(var(--primary-foreground)/.2)] bg-[hsl(var(--primary-foreground)/.1)] text-[hsl(var(--primary-foreground))]" onClick={() => persist(true)} data-testid="button-save-split"><Check size={17} /> Save to history</button></div></div><p className="mt-5 text-center text-xs text-[hsl(var(--muted-foreground))]">Saved locally on this device. You can revisit it anytime.</p></section>;
}

function HistoryPage() {
  const [, setLocation] = useLocation();
  const [bills, setBills] = useState<Bill[]>(readBills);
  const [renameId, setRenameId] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const sorted = bills.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const openBill = (bill: Bill) => { localStorage.setItem(DRAFT_KEY, JSON.stringify(bill)); setLocation('/bill/new'); };
  const duplicate = (bill: Bill) => { const copy = cloneBill(bill); const next = [copy, ...bills]; setBills(next); writeBills(next); };
  const remove = (id: string) => { if (!window.confirm('Delete this saved split?')) return; const next = bills.filter((bill) => bill.id !== id); setBills(next); writeBills(next); };
  const saveRename = (id: string) => { const next = bills.map((bill) => bill.id === id ? { ...bill, merchant: renameValue.trim() || bill.merchant } : bill); setBills(next); writeBills(next); setRenameId(''); };
  return <Shell><main className="mx-auto max-w-5xl px-4 pb-16 pt-8 sm:px-6 sm:pt-12"><div className="mb-8 flex items-end justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.16em] text-[hsl(var(--accent))]">kept on this device</p><h1 className="mt-1 font-display text-4xl font-bold tracking-[-.06em]">History</h1><p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">A small shelf for the bills you’ll want to reference again.</p></div><Link href="/bill/new" className="btn-primary" data-testid="link-new-history"><Plus size={17} /> <span className="hidden sm:inline">New bill</span></Link></div>{sorted.length === 0 ? <div className="dotted-card flex flex-col items-center px-6 py-20 text-center"><div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><HistoryIcon size={25} /></div><h2 className="font-display text-xl font-bold">Nothing saved yet</h2><p className="mt-2 max-w-sm text-sm leading-6 text-[hsl(var(--muted-foreground))]">Once you finish a split, it will appear here without an account or sync setup.</p><Link href="/bill/new" className="btn-secondary mt-6" data-testid="link-first-history"><FilePlus2 size={17} /> Make your first split</Link></div> : <div className="space-y-3">{sorted.map((bill) => <article key={bill.id} className="card-shell p-4 transition-transform hover:-translate-y-0.5 sm:p-5" data-testid={`card-history-${bill.id}`}><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex min-w-0 items-center gap-3"><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><ReceiptText size={19} /></span><div className="min-w-0">{renameId === bill.id ? <div className="flex gap-2"><input autoFocus className="input-shell max-w-xs" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && saveRename(bill.id)} data-testid={`input-rename-${bill.id}`} /><button type="button" className="btn-primary !min-h-10 !px-3" onClick={() => saveRename(bill.id)} data-testid={`button-save-rename-${bill.id}`}><Check size={15} /></button></div> : <h2 className="truncate font-display text-lg font-bold">{bill.merchant || 'Untitled bill'}</h2>}<p className="mt-0.5 text-sm text-[hsl(var(--muted-foreground))]">{shortDate(bill.date)} · {bill.people.length} people · {bill.items.length} items</p></div></div><div className="flex flex-wrap items-center gap-2 sm:justify-end"><span className="mr-1 font-display text-lg font-bold">{money(bill.adjustments.grandTotal, bill.currency)}</span><button type="button" className="btn-ghost !min-h-10 !px-3" onClick={() => openBill(bill)} aria-label={`Open ${bill.merchant}`} data-testid={`button-open-${bill.id}`}><Pencil size={15} /> <span className="hidden md:inline">Open</span></button><button type="button" className="btn-ghost !min-h-10 !px-3" onClick={() => { setRenameId(bill.id); setRenameValue(bill.merchant); }} aria-label={`Rename ${bill.merchant}`} data-testid={`button-rename-${bill.id}`}><Pencil size={15} /></button><button type="button" className="btn-ghost !min-h-10 !px-3" onClick={() => duplicate(bill)} aria-label={`Duplicate ${bill.merchant}`} data-testid={`button-duplicate-${bill.id}`}><Copy size={15} /></button><button type="button" className="btn-ghost !min-h-10 !px-3 text-[hsl(var(--destructive))]" onClick={() => remove(bill.id)} aria-label={`Delete ${bill.merchant}`} data-testid={`button-delete-history-${bill.id}`}><Trash2 size={15} /></button></div></div></article>)}</div>}</main></Shell>;
}

function NotFound() {
  return <Shell><main className="mx-auto flex min-h-[65dvh] max-w-xl flex-col items-center justify-center px-6 text-center"><span className="font-mono text-sm font-bold text-[hsl(var(--accent))]">404 / not on the bill</span><h1 className="mt-3 font-display text-4xl font-bold">This page got left off the receipt.</h1><p className="mt-3 text-[hsl(var(--muted-foreground))]">Let’s get you back to a useful kind of math.</p><Link href="/" className="btn-primary mt-7" data-testid="link-not-found-home"><ArrowRight size={17} /> Back to Roomies</Link></main></Shell>;
}

const queryClient = new QueryClient();
function Router() {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}><Switch><Route path="/" component={HomePage} /><Route path="/bill/new" component={BillPage} /><Route path="/history" component={HistoryPage} /><Route component={NotFound} /></Switch></ErrorBoundary>;
}
function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}
export default App;