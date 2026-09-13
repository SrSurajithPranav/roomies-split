# Roomies Split

Roomies Split turns receipt photos or manual line items into an exact, shareable bill split for roommates and friends.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/roomies-split/src/App.tsx` — mobile-first app shell and local bill flows
- `artifacts/roomies-split/src/lib/split-engine.ts` — deterministic allocation and rounding logic
- `artifacts/api-server/src/routes/receipt.ts` — server-side receipt extraction endpoint
- `lib/api-spec/openapi.yaml` — source of truth for the receipt parsing contract
- `artifacts/roomies-split/src/index.css` — Roomies visual tokens and responsive styles

## Architecture decisions

- Anonymous bills and history stay in browser localStorage; there is no required account or user database.
- Receipt images are sent only during an explicit parse action; the server returns structured data for user review rather than calculating a split.
- The split engine operates in integer paise/cents and distributes remainder amounts predictably so person totals always reconcile.
- Receipt parsing uses a server-side provider boundary and schema validation, allowing the AI provider to be replaced without changing the UI contract.

## Product

- Start from a manual bill or receipt images, including multiple images and drag-and-drop.
- Review and edit extracted items, add people, select a payer, and allocate items equally, by percentage, or by quantity.
- Reconcile discounts, CGST, SGST, IGST, other charges, round-off, and receipt-total mismatches.
- Save local history, duplicate or rename past bills, and share the final split using native share or clipboard.

## User preferences

No additional preferences recorded.

## Gotchas

- Frontend artifact workflows provide `PORT` and `BASE_PATH`; direct Vite builds need both values explicitly.
- Receipt parsing uses `GEMINI_API_KEY` with Gemini 3.6 Flash. The deployment must have that secret in its production secret store; if it is missing, `/api/receipt/parse` returns a clear JSON 502 that the frontend displays as-is instead of a generic string.
- Receipt calls have a 30-second timeout and log the provider status/body plus image count and payload size without logging the image data itself.
- GST on Indian receipts is printed two ways: additive (subtotal + CGST/SGST on top, typical for restaurants) or already inclusive (item prices include GST; any "GST breakup" table is informational, typical for grocery/retail). The extraction prompt normalizes to additive and zeroes cgst/sgst/igst (with a warning) when a receipt's tax is already baked into the total, so the split engine never double-counts it.
- Fresh checkouts must delete any committed `*.tsbuildinfo` before `pnpm run typecheck` — stale build info can make `tsc --build` skip rebuilding `lib/*` packages and produce confusing `TS6305`/implicit-any errors that aren't real code issues.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
