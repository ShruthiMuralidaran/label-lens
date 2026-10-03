// /api/check-label.js — Vercel serverless function
// POST: receives image + category + ingredient term, calls Gemini, saves to Supabase, returns result + count
// GET:  returns the total label-check count from Supabase

const SYSTEM_PROMPT = `You are LabelLens, an ingredient-label reading assistant embedded in a consumer product website. Your only job is to check whether a single user-specified ingredient term appears in the readable text of a photographed product label.

You receive: a product category (packaged food, personal care, or household), one ingredient term to check, and a photo of the product's ingredient panel.

Respond in this exact structure:
- Result: one of "Found", "Not found in readable text", or "Cannot determine"
- Phrase: the exact words from the label that matched, only if Result is "Found". Otherwise write "N/A"
- Explanation: one sentence explaining what you found or why you could not determine a result
- Limitation: one sentence stating what this check does not establish

Rules you must follow:
1. Only check the ingredient term provided. Do not scan for anything else.
2. If the image is blurry, cut off, or not a recognizable ingredient panel, return "Cannot determine" and explain why.
3. "Not found in readable text" means the term was not detected in whatever text you could read. It does not mean the product is free of that ingredient. State this in the limitation.
4. Never say a product is "safe", "approved", "certified", or "recommended".
5. Never diagnose a medical condition, suggest treatment, or prescribe dietary rules.
6. Never give advice about whether to buy or avoid the product.
7. If the user sends something that is not a product label (a selfie, a meme, a question, a recipe), refuse politely: "I can only check ingredient labels. Please upload a photo of a product's ingredient panel."
8. Keep your total response under 80 words.`;

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

  // ---------- GET: return the total count ----------
  if (req.method === 'GET') {
    try {
      const countRes = await fetch(
        `${SUPABASE_URL}/rest/v1/label_checks?select=id`,
        {
          method: 'HEAD',
          headers: {
            apikey: SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
            Prefer: 'count=exact',
          },
        }
      );
      const range = countRes.headers.get('content-range') || '*/0';
      const total = parseInt(range.split('/')[1], 10) || 0;
      return res.status(200).json({ total });
    } catch (err) {
      return res.status(200).json({ total: 0 });
    }
  }

  // ---------- POST: check a label ----------
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { image_base64, mime_type, category, ingredient_term } = req.body;

  // Validate inputs
  if (!image_base64 || !mime_type || !category || !ingredient_term) {
    return res.status(400).json({ error: 'Missing required fields: image_base64, mime_type, category, ingredient_term' });
  }

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(mime_type)) {
    return res.status(400).json({ error: 'Unsupported image type. Use JPEG, PNG, or WebP.' });
  }

  // Check approximate size (base64 is ~4/3 of original)
  const approxBytes = (image_base64.length * 3) / 4;
  if (approxBytes > 3 * 1024 * 1024) {
    return res.status(400).json({ error: 'Image too large. Maximum 3 MB.' });
  }

  const allowedCategories = ['Packaged food', 'Personal care', 'Household'];
  if (!allowedCategories.includes(category)) {
    return res.status(400).json({ error: 'Invalid category.' });
  }

  if (ingredient_term.length > 60) {
    return res.status(400).json({ error: 'Ingredient term too long. Keep it under 60 characters.' });
  }

  try {
    // ---------- Call Gemini ----------
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

    const userMessage = `Product category: ${category}\nIngredient to check: ${ingredient_term}\n\nThe attached photo is the product's ingredient panel. Check it now.`;

    const geminiBody = {
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        {
          parts: [
            { text: userMessage },
            {
              inline_data: {
                mime_type: mime_type,
                data: image_base64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: 350,
        temperature: 0.2,
      },
    };

    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    });

    const geminiData = await geminiRes.json();

    if (!geminiRes.ok) {
      console.error('Gemini error:', JSON.stringify(geminiData));
      return res.status(502).json({ error: 'AI service returned an error. Please try again.' });
    }

    const answer =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ||
      'Cannot determine. The image could not be processed.';

    const inputTokens =
      geminiData?.usageMetadata?.promptTokenCount || 0;
    const outputTokens =
      geminiData?.usageMetadata?.candidatesTokenCount || 0;

    // ---------- Parse result type from answer ----------
    let resultType = 'Cannot determine';
    const lower = answer.toLowerCase();
    if (lower.includes('result: found') && !lower.includes('not found')) {
      resultType = 'Found';
    } else if (lower.includes('not found in readable text')) {
      resultType = 'Not found in readable text';
    }

    // ---------- Save to Supabase ----------
    const row = {
      category,
      ingredient_term,
      result_type: resultType,
      response: answer,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    };

    await fetch(`${SUPABASE_URL}/rest/v1/label_checks`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    });

    // ---------- Get updated count ----------
    const countRes = await fetch(
      `${SUPABASE_URL}/rest/v1/label_checks?select=id`,
      {
        method: 'HEAD',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          Prefer: 'count=exact',
        },
      }
    );
    const range = countRes.headers.get('content-range') || '*/0';
    const total = parseInt(range.split('/')[1], 10) || 0;

    // ---------- Return ----------
    return res.status(200).json({ answer, total });
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
