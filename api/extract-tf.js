// Vercel serverless function — POST { text } → structured JSON extracted by Claude.
// Requires ANTHROPIC_API_KEY set as an environment variable in the Vercel project
// (Project Settings → Environment Variables). Never commit the key itself.
//
// Why this exists: the local regex parser (src/App.jsx, extractData) is fast,
// free, and 100% client-side, but brittle to document-layout variation (labels
// glued to numbers, letter-spaced fonts, blank columns, different currency
// glyphs...). Each new real-world PDF format has needed a manual fix. Claude
// reads the text the way a human would — robust to formatting quirks — at a
// cost of roughly $0.005–0.01 per document on Haiku. The regex parser stays in
// place as an automatic fallback if this call fails (network issue, missing
// API key, rate limit) so the tool never breaks outright.

const SYSTEM_PROMPT = `Tu extrais des données structurées d'un avis de taxe foncière français (DGFiP), à partir d'un texte brut obtenu par extraction PDF (qui peut contenir des artefacts : lettres séparées par des espaces, labels collés aux nombres, tableaux avec colonnes vides pour des taxes non applicables, symbole monétaire "¤" au lieu de "€").

Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ni après, sans balises markdown, correspondant exactement à ce format :

{
  "entreprise": string ou null,
  "adresse": string ou null,
  "commune": string ou null,
  "departement": string ou null,
  "annee": number,
  "referenceAdministrative": string ou null,
  "montantTotal": number ou null,
  "baseCommune": number ou null,
  "baseEPCI": number ou null,
  "baseOM": number ou null,
  "baseSyndicats": number ou null,
  "baseGEMAPI": number ou null,
  "baseAutre": number ou null,
  "tauxCommune": number ou null,
  "tauxEPCI": number ou null,
  "tauxOM": number ou null,
  "tauxSyndicats": number ou null,
  "tauxGEMAPI": number ou null,
  "tauxAutre": number ou null,
  "cotisationCommune": number ou null,
  "cotisationEPCI": number ou null,
  "cotisationOM": number ou null,
  "cotisationSyndicats": number ou null,
  "cotisationGEMAPI": number ou null,
  "cotisationAutre": number ou null,
  "cotisationTotal": number ou null,
  "fraisGestion": number ou null,
  "lissage": boolean,
  "lissageMontantAnnuel": number ou null,
  "lissageDebut": number ou null,
  "lissageDuree": number ou null
}

Règles impératives :
- Si une information n'est pas présente dans le texte, mets sa valeur à null — n'invente JAMAIS une donnée absente. C'est un outil financier, l'exactitude prime sur la complétude.
- Les taux sont exprimés en POURCENTAGE (ex: 22.57 pour 22,57%), jamais en fraction décimale.
- "cotisationX" désigne le montant réellement appelé pour cette collectivité (après lissage éventuel), pas un recalcul base×taux — utilise le montant tel qu'il apparaît explicitement dans le tableau du document, s'il y est.
- "fraisGestion" et "cotisationTotal" ne doivent être remplis QUE s'ils apparaissent explicitement comme tels dans le texte — ne les recalcule jamais toi-même, un autre système s'en charge séparément.
- "tauxSyndicats" à 0 (pas null) si le document indique explicitement un taux vide/blanc pour le syndicat de communes (ça signifie que cette taxe ne s'applique pas à ce bien, ce qui est different de "donnée manquante").`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { text } = req.body || {};
  if (!text || typeof text !== "string" || text.length < 30) {
    res.status(400).json({ error: "Missing or invalid 'text' field" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY not configured on the server" });
    return;
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: text.slice(0, 20000) }],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      res.status(502).json({ error: "Anthropic API error", detail });
      return;
    }

    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === "text");
    if (!textBlock) {
      res.status(502).json({ error: "No text content in Anthropic response" });
      return;
    }

    let parsed;
    try {
      const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      res.status(502).json({ error: "Failed to parse JSON from model", raw: textBlock.text });
      return;
    }

    res.status(200).json(parsed);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
}
