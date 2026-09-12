import { Router, type IRouter } from "express";
import { ParseReceiptBody, ParseReceiptResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const receiptSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    merchant: { type: "string" },
    address: { type: ["string", "null"] },
    date: { type: ["string", "null"] },
    currency: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          quantity: { type: "number" },
          unit: { type: "string" },
          unitPrice: { type: "number" },
          totalPrice: { type: "number" },
          discount: { type: "number" },
          tax: { type: "number" },
          confidence: { type: "number" },
        },
        required: [
          "id",
          "name",
          "quantity",
          "unit",
          "unitPrice",
          "totalPrice",
          "discount",
          "tax",
          "confidence",
        ],
      },
    },
    subtotal: { type: ["number", "null"] },
    discount: { type: "number" },
    cgst: { type: "number" },
    sgst: { type: "number" },
    igst: { type: "number" },
    otherCharges: { type: "number" },
    roundOff: { type: "number" },
    grandTotal: { type: ["number", "null"] },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: [
    "merchant",
    "address",
    "date",
    "currency",
    "items",
    "subtotal",
    "discount",
    "cgst",
    "sgst",
    "igst",
    "otherCharges",
    "roundOff",
    "grandTotal",
    "warnings",
  ],
} as const;

const extractionPrompt = `You extract structured data from Indian receipts for a bill splitting app.

Return only JSON matching the supplied schema. Never guess unreadable values: use an empty string for merchant if unreadable, null for unknown address/date/subtotal/grandTotal, 0 for unknown numeric adjustments, and add a clear warning. Use currency INR unless another currency is clearly printed.

For every line item, preserve what the receipt shows. quantity may be decimal for weight/volume items. unit should be a short normalized label such as pcs, kg, g, l, ml, pack, or item. unitPrice is the price for one unit when the receipt makes that clear; totalPrice is the line total. If only a line total is visible, set unitPrice equal to totalPrice when quantity is 1. Do not calculate or invent a total that is not supported by the receipt. confidence is between 0 and 1.

Recognize Indian receipt terms including CGST, SGST, IGST, GST, CESS, service charge, delivery, discount, coupon, round off, MRP, net amount, and total. Use a stable unique id for each item such as item-1.

Indian receipts print GST two different ways, and you must normalize to one convention so the numbers add up correctly:
- Additive (common on restaurant/service bills): a pre-tax subtotal is shown, then CGST/SGST/IGST are added on top to reach the grand total (e.g. Sub Total 330 + CGST 8.25 + SGST 8.25 + Round off 0.50 = Grand Total 347).
- Inclusive (common on retail/grocery bills): item and subtotal amounts already include GST, and any "GST Breakup" table is only an informational disclosure of how much tax is embedded in the total already paid — it is not an extra charge.
The output must always follow the additive convention: items[].totalPrice summed equals subtotal, and subtotal - discount + cgst + sgst + igst + otherCharges + roundOff must equal grandTotal. If the receipt's own GST section is inclusive (the grand/net total already accounts for it), set cgst, sgst, and igst to 0 rather than adding an already-embedded tax on top again, and add a warning noting the receipt's tax is included in item prices and was not broken out. Only report non-zero cgst/sgst/igst when they are genuinely additional amounts on top of a stated pre-tax subtotal.`;

router.post("/receipt/parse", async (req, res): Promise<void> => {
  const parsed = ParseReceiptBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid receipt parse request");
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    req.log.error("OPENAI_API_KEY is not configured");
    res.status(502).json({ error: "Receipt scanning is not configured yet." });
    return;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "receipt_extraction",
            strict: true,
            schema: receiptSchema,
          },
        },
        messages: [
          {
            role: "system",
            content: extractionPrompt,
          },
          {
            role: "user",
            content: parsed.data.images.map((image) => ({
              type: "image_url",
              image_url: { url: image.dataUrl, detail: "high" },
            })),
          },
        ],
        max_tokens: 5000,
      }),
    });

    if (!response.ok) {
      const providerMessage = await response.text();
      req.log.error(
        { status: response.status, providerMessage: providerMessage.slice(0, 500) },
        "Receipt provider request failed",
      );
      res.status(502).json({ error: "We couldn't read this receipt. You can enter the bill manually." });
      return;
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      res.status(502).json({ error: "The receipt reader returned no usable data." });
      return;
    }

    let extraction: unknown;
    try {
      extraction = JSON.parse(content);
    } catch {
      req.log.warn("Receipt provider returned invalid JSON");
      res.status(502).json({ error: "The receipt reader returned invalid data." });
      return;
    }

    const validated = ParseReceiptResponse.safeParse(extraction);
    if (!validated.success) {
      req.log.warn({ errors: validated.error.message }, "Receipt extraction failed validation");
      res.status(502).json({ error: "We couldn't verify the receipt details. Please review them manually." });
      return;
    }

    res.json(validated.data);
  } catch (error) {
    req.log.error({ err: error }, "Unexpected receipt parsing failure");
    res.status(502).json({ error: "Receipt scanning is temporarily unavailable." });
  }
});

export default router;