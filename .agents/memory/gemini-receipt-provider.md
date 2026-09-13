---
name: Gemini receipt provider
description: Receipt parsing uses direct Gemini access with a configurable model because provider model availability can change by account.
---

Keep the receipt model configurable through `GEMINI_MODEL`, log the provider status/body on failures, and retain a bounded request timeout.

**Why:** The provider rejected `gemini-2.5-flash` for this account even though the key was valid, and its response identified `gemini-3.6-flash` as the supported replacement.

**How to apply:** When receipt parsing fails with a provider 4xx/5xx, inspect the logged raw response before changing prompts or frontend fallbacks; do not assume an API key or image payload is the cause.