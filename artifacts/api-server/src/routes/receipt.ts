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

const geminiReceiptSchema = {
  type: "OBJECT",
  properties: {
    merchant: { type: "STRING" },
    address: { type: "STRING", nullable: true },
    date: { type: "STRING", nullable: true },
    currency: { type: "STRING" },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING" },
          name: { type: "STRING" },
          quantity: { type: "NUMBER" },
          unit: { type: "STRING" },
          unitPrice: { type: "NUMBER" },
          totalPrice: { type: "NUMBER" },
          discount: { type: "NUMBER" },
          tax: { type: "NUMBER" },
          confidence: { type: "NUMBER" },
        },
        required: ["id", "name", "quantity", "unit", "unitPrice", "totalPrice", "discount", "tax", "confidence"],
      },
    },
    subtotal: { type: "NUMBER", nullable: true },
    discount: { type: "NUMBER" },
    cgst: { type: "NUMBER" },
    sgst: { type: "NUMBER" },
    igst: { type: "NUMBER" },
    otherCharges: { type: "NUMBER" },
    roundOff: { type: "NUMBER" },
    grandTotal: { type: "NUMBER", nullable: true },
    warnings: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["merchant", "address", "date", "currency", "items", "subtotal", "discount", "cgst", "sgst", "igst", "otherCharges", "roundOff", "grandTotal", "warnings"],
};

const receiptTimeoutMs = 30_000;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function toGeminiInlineImage(dataUrl: string): { mime_type: string; data: string } {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) throw new Error("Receipt image must be a base64 data URL.");
  return { mime_type: match[1], data: match[2] };
}

router.post("/receipt/parse", async (req, res): Promise<void> => {
  const parsed = ParseReceiptBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid receipt parse request");
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    req.log.error("GEMINI_API_KEY is not configured");
    res.status(502).json({ error: "Receipt scanning is not configured yet. Add GEMINI_API_KEY to the deployment secrets." });
    return;
  }

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  let inlineImages: Array<{ inline_data: { mime_type: string; data: string } }>;
  try {
    inlineImages = parsed.data.images.map((image) => ({ inline_data: toGeminiInlineImage(image.dataUrl) }));
  } catch (error) {
    req.log.warn({ err: error }, "Invalid receipt image data URL");
    res.status(400).json({ error: "Receipt image data is invalid. Try another clear photo." });
    return;
  }

  const providerRequest = {
    contents: [{
      role: "user",
      parts: [{ text: extractionPrompt }, ...inlineImages],
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: geminiReceiptSchema,
      temperature: 0,
      maxOutputTokens: 5000,
    },
  };
  const requestBody = JSON.stringify(providerRequest);
  const payloadBytes = Buffer.byteLength(requestBody, "utf8");
  const imageBytes = parsed.data.images.reduce((total, image) => total + Buffer.byteLength(image.dataUrl, "utf8"), 0);

  req.log.info(
    {
      provider: "gemini",
      model,
      imageCount: parsed.data.images.length,
      payloadBytes,
      imageDataUrlBytes: imageBytes,
    },
    "Receipt provider request prepared",
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), receiptTimeoutMs);
  const providerUrl = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(apiKey);

  try {
    const response = await fetch(providerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
      signal: controller.signal,
    });
    const rawResponseBody = await response.text();

    if (!response.ok) {
      req.log.error(
        {
          provider: "gemini",
          status: response.status,
          statusText: response.statusText,
          responseBody: rawResponseBody.slice(0, 12000),
        },
        "Receipt provider request failed",
      );
      res.status(502).json({ error: "Receipt scanning provider returned HTTP " + response.status + ". Try again or enter items manually." });
      return;
    }

    let payload: {
      candidates?: Array<{
        finishReason?: string;
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };
    try {
      payload = JSON.parse(rawResponseBody) as typeof payload;
    } catch (error) {
      req.log.error({ err: error, provider: "gemini", responseBody: rawResponseBody.slice(0, 12000) }, "Receipt provider returned invalid JSON");
      res.status(502).json({ error: "The receipt reader returned invalid data. Try again or enter items manually." });
      return;
    }

    const candidate = payload.candidates?.[0];
    const content = candidate?.content?.parts?.map((part) => part.text || "").join("").trim();
    if (!content) {
      req.log.error(
        {
          provider: "gemini",
          finishReason: candidate?.finishReason,
          responseBody: rawResponseBody.slice(0, 12000),
        },
        "Receipt provider returned no usable content",
      );
      res.status(502).json({ error: "The receipt reader returned no usable data. Try again or enter items manually." });
      return;
    }

    let extraction: unknown;
    try {
      extraction = JSON.parse(content);
    } catch (error) {
      req.log.error({ err: error, provider: "gemini", responseBody: rawResponseBody.slice(0, 12000), content: content.slice(0, 12000) }, "Receipt provider returned non-JSON content");
      res.status(502).json({ error: "The receipt reader returned invalid data. Try again or enter items manually." });
      return;
    }

    const validated = ParseReceiptResponse.safeParse(extraction);
    if (!validated.success) {
      req.log.error(
        { provider: "gemini", errors: validated.error.message, responseBody: rawResponseBody.slice(0, 12000), content: content.slice(0, 12000) },
        "Receipt extraction failed validation",
      );
      res.status(502).json({ error: "We couldn't verify the receipt details. Please review them manually." });
      return;
    }

    res.json(validated.data);
  } catch (error) {
    if (isAbortError(error)) {
      req.log.warn({ provider: "gemini", timeoutMs: receiptTimeoutMs, imageCount: parsed.data.images.length, payloadBytes }, "Receipt provider request timed out");
      res.status(502).json({ error: "Receipt scanning timed out. Try again or enter items manually." });
      return;
    }

    req.log.error(
      { err: error, provider: "gemini", imageCount: parsed.data.images.length, payloadBytes },
      "Unexpected receipt provider failure",
    );
    res.status(502).json({ error: "Receipt scanning is temporarily unavailable. Try again or enter items manually." });
  } finally {
    clearTimeout(timeoutId);
  }
});

export default router;
