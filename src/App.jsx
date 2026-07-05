import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Download, Upload, ChevronRight, XCircle } from "lucide-react";

// PDF.js
const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

async function extractPdfText(base64) {
  if (!window.pdfjsLib) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = PDFJS_CDN; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pdf = await window.pdfjsLib.getDocument({ data: bytes }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += reconstructLines(content.items) + "\n";
  }
  return text;
}

// PDF.js returns items in content-stream order, NOT reading order. On a
// multi-column table (Commune / Syndicat / Interco / OM / GEMAPI side by
// side) a naive join() interleaves cells and the regexes below match the
// wrong numbers. We rebuild real rows using each item's y position (line)
// then sort left-to-right by x within that line before joining.
function reconstructLines(items) {
  const Y_TOLERANCE = 2;
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    let row = rows.find(r => Math.abs(r.y - y) <= Y_TOLERANCE);
    if (!row) { row = { y, items: [] }; rows.push(row); }
    row.items.push({ x, str: it.str });
  }
  rows.sort((a, b) => b.y - a.y); // PDF y-axis grows upward: top of page first
  return rows
    .map(r => r.items.sort((a, b) => a.x - b.x).map(i => i.str).join(" "))
    .join("\n");
}

// ---- Pure JS extraction from PDF text ----
function parseNum(str) {
  if (!str) return null;
  // French formatting: spaces / narrow no-break spaces as thousand separators, comma as decimal
  const cleaned = str.replace(/[\s  ]/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

const PCT_RE = /(\d{1,3}[,\.]\d{1,3})\s*%/;
// IMPORTANT: no \s inside the digit run. A "Base" row on the avis often has
// several distinct columns on one line ("936 898 898 898 898 €" = commune,
// EPCI, OM, syndicat, GEMAPI). A regex that tolerates spaces between digits
// (to allow French thousand-separators) ends up swallowing all of them into
// one giant number instead of stopping at the first value. These amounts
// are small enough (a few thousand euros max) that a plain contiguous digit
// run is safer than trying to guess where a real separator ends.
const NUM_RE = /(\d+(?:[,\.]\d{1,2})?)\s*[€¤]?/;
// Grabs every distinct number on a line — used for multi-column rows like "Base".
const ALL_NUMS_RE = /\d+(?:[,\.]\d{1,2})?/g;

// Search line-by-line for a label, then pull the first matching value on
// that same line or within the next couple of lines (handles wrapped /
// multi-line table cells where label and value land on separate rows).
function findValue(lines, labelPatterns, valueRe, aheadLines = 2) {
  for (let i = 0; i < lines.length; i++) {
    if (!labelPatterns.some(p => p.test(lines[i]))) continue;
    for (let j = 0; j <= aheadLines && i + j < lines.length; j++) {
      const m = lines[i + j].match(valueRe);
      if (m) return m[1];
    }
  }
  return null;
}

function extractData(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const t = text.replace(/\s+/g, " ");

  // Propriétaire
  const proprioMatch = t.match(/SCI\s+[\w\s]+|SARL\s+[\w\s]+|SAS\s+[\w\s]+|EURL\s+[\w\s]+|M[MR]\.\s+[\w\s]+/i);
  const entreprise = proprioMatch ? proprioMatch[0].trim().slice(0, 40) : null;

  // Commune — try the reliable "Commune d'imposition : XX <NOM>" label first
  // (present on the main avis), then fall back to the "standalone caps line
  // before Montant de..." heuristic used on the avis d'échéances, which
  // doesn't have that label at all.
  let commune = null;
  const communeLabelIdx = lines.findIndex(l => /Commune\s*d.imposition/i.test(l));
  if (communeLabelIdx !== -1) {
    for (let j = 0; j <= 2 && communeLabelIdx + j < lines.length; j++) {
      const candidate = lines[communeLabelIdx + j].replace(/Commune\s*d.imposition\s*:?\s*\d*/i, "").trim();
      if (/^[A-ZÀ-Ÿ][A-ZÀ-Ÿ\-\s]{2,30}$/.test(candidate)) { commune = candidate; break; }
    }
  }
  if (!commune) {
    const montantLineIdx = lines.findIndex(l => /Montant\s+de\s+(vos|votre)\s+tax(es?)?\s+fonci.re/i.test(l) || /Montant\s+de\s+votre\s+imp.t/i.test(l));
    if (montantLineIdx > 0) {
      for (let i = montantLineIdx - 1; i >= Math.max(0, montantLineIdx - 3); i--) {
        const candidate = lines[i].trim();
        if (/^[A-ZÀ-Ÿ][A-ZÀ-Ÿ\-\s]{2,30}$/.test(candidate)) { commune = candidate; break; }
      }
    }
  }
  if (!commune) {
    const communeMatch = t.match(/commune\s+de\s*:?\s*\n?\s*([A-Z][A-Z\-\s]+)/i);
    commune = communeMatch ? communeMatch[1].trim().slice(0, 30) : null;
  }

  // Département — derive from any 5-digit postal code in the document (first
  // 2 digits), since there's no explicit "Département : XX" label here.
  const deptMatch = t.match(/[Dd].partement\s+d.imposition\s*:?\s*(\d{2,3})/) || t.match(/\b(\d{2})\d{3}\b(?=\s+[A-ZÀ-Ÿ])/);
  const departement = deptMatch ? deptMatch[1] : null;

  // Adresse du bien (240 CHE DE MARRET style)
  const adresseMatch = t.match(/(\d{1,4}\s+(?:CHE|RUE|AV|BD|IMP|ALL|PL)\s+[\w\s]+?)(?=\s{2,}|\n)/i);
  const adresse = adresseMatch ? adresseMatch[1].trim().slice(0, 60) : null;

  // Année — "Montant de vos taxes foncières 3685,00 ¤" was wrongly matched as
  // a year before (3685 IS 4 digits!). Anchor instead on the specific sentence
  // that introduces the rate table, or on "Taxes foncières pour YYYY" / "Taux YYYY".
  const anneeMatch = t.match(/suivantes\s+pour\s+(\d{4})\s*:/i) || t.match(/exercice\s+(\d{4})/i)
    || t.match(/Taxes\s+fonci.res\s+pour\s+(\d{4})/i) || t.match(/Taux\s*(\d{4})/i);
  const anneeCandidate = anneeMatch ? parseInt(anneeMatch[1]) : null;
  const annee = (anneeCandidate && anneeCandidate > 2015 && anneeCandidate < 2035) ? anneeCandidate : 2025;

  // ---- Taux, per collectivité ----
  // Two real layouts seen so far: (a) a bare line of 6 space-separated
  // numbers with no label and no "%" (avis d'échéances); (b) a labeled line
  // like "Taux2025 50,48 % % 4,77 % 0,609 % 13,86 % 0,314 %" where a column
  // can be entirely BLANK (no digits at all, just "%") when that tax doesn't
  // apply to this property (e.g. no syndicat de communes). Blank columns
  // must be preserved as null-in-place so we don't shift the remaining
  // values into the wrong column.
  function parseTauxLine(line) {
    const trimmed = line.trim();
    if (trimmed.includes("%")) {
      const pctCount = (trimmed.match(/%/g) || []).length;
      if (pctCount !== 6) return null;
      // Only a line labeled "Taux..." (or with no label at all) is a real
      // rate row — a "Variation" row also carries 6 "%" signs and must not
      // be mistaken for one.
      const labelMatch = trimmed.match(/^([A-Za-zÀ-ÿ]+)\s*\d{0,4}\s*/);
      if (labelMatch && !/^taux/i.test(labelMatch[1])) return null;
      const stripped = labelMatch ? trimmed.slice(labelMatch[0].length) : trimmed;
      const parts = stripped.split("%");
      if (parts.length < 6) return null;
      return parts.slice(0, 6).map(p => {
        const m = p.match(/(\d{1,3}[,\.]\d{1,3})/);
        return m ? parseNum(m[1]) : null;
      });
    }
    const m = trimmed.match(/^(\d{1,3}[,\.]\d{1,3})\s+(\d{1,3}[,\.]\d{1,3})\s+(\d{1,3}[,\.]\d{1,3})\s+(\d{1,3}[,\.]\d{1,3})\s+(\d{1,3}[,\.]\d{1,3})\s+(\d{1,3}[,\.]\d{1,3})$/);
    return m ? m.slice(1, 7).map(parseNum) : null;
  }

  let tauxRows = [];
  let tauxRowIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const row = parseTauxLine(lines[i]);
    if (row) { tauxRows.push(row); if (tauxRowIdx === -1) tauxRowIdx = i; }
  }

  let tauxCommune = null, tauxSyndicats = null, tauxEPCI = null, tauxOM = null, tauxGEMAPI = null, tauxAutre = null;
  let colOrder = null; // remembers which column index maps to which collectivité, reused for base/cotisation rows
  let nonNullOrder = null; // original column indices that had a value, left-to-right — base/cotisation rows omit blank columns entirely, so this realigns them

  if (tauxRows.length >= 1) {
    const current = tauxRows[tauxRows.length - 1]; // most recent year = last matching row
    nonNullOrder = current.map((v, i) => i).filter(i => current[i] != null);
    const remaining = nonNullOrder.map(i => ({ v: current[i], i }));

    // (1) Narrative anchor for syndicat, if present.
    const syndMatch = t.match(/syndicat[^%]*?(\d{1,3}[,\.]\d{1,3})\s*%?\s*(?:à|a)\s*(\d{1,3}[,\.]\d{1,3})\s*%/i);
    let syndIdx = -1;
    if (syndMatch) {
      const targetVal = parseNum(syndMatch[2]);
      const found = remaining.find(x => Math.abs(x.v - targetVal) < 0.01);
      if (found) syndIdx = found.i;
    }

    // (2) Magnitude fallback for the rest: commune is always the largest;
    // ordures ménagères (OM) is usually the biggest of what's left, then
    // intercommunalité (EPCI), then GEMAPI. Not a perfect convention (a
    // small unlabeled 6th tax can occasionally outrank GEMAPI or vice
    // versa), but since both end up in the same 3%-frais-de-gestion bucket
    // either way, a swap here doesn't affect the exactness of the recalcul —
    // only a display label, in the rare case it happens.
    const sorted = [...remaining].sort((a, b) => b.v - a.v);
    const communeIdx = sorted[0]?.i;
    const pool = sorted.filter(x => x.i !== communeIdx && x.i !== syndIdx);
    const omIdx = pool[0]?.i;
    const epciIdx = pool[1]?.i;
    const gemapiIdx = pool[2]?.i;
    const autreIdx = pool[3]?.i;

    colOrder = { communeIdx, syndIdx, epciIdx, omIdx, gemapiIdx, autreIdx };
    tauxCommune = communeIdx != null ? current[communeIdx] / 100 : null;
    tauxSyndicats = syndIdx != null && syndIdx !== -1 ? current[syndIdx] / 100 : 0;
    tauxEPCI = epciIdx != null ? current[epciIdx] / 100 : null;
    tauxOM = omIdx != null ? current[omIdx] / 100 : null;
    tauxGEMAPI = gemapiIdx != null ? current[gemapiIdx] / 100 : null;
    tauxAutre = autreIdx != null ? current[autreIdx] / 100 : null;
  } else {
    // Fallback for documents with a totally different layout: label-anchored search.
    const tauxCommuneStr = findValue(lines, [/taux\s+commun/i], PCT_RE);
    const tauxSyndicatsStr = findValue(lines, [/taux\s+syndicat/i], PCT_RE);
    const tauxEPCIStr = findValue(lines, [/taux\s+interco/i, /taux\s+intercommunal/i, /\bEPCI\b/i], PCT_RE);
    const tauxOMStr = findValue(lines, [/taux\s+OM\b/i, /ordures\s+m[ée]nag/i], PCT_RE);
    const tauxGEMAPIStr = findValue(lines, [/GEMAPI/i], PCT_RE);
    tauxCommune = tauxCommuneStr ? parseNum(tauxCommuneStr) / 100 : null;
    tauxSyndicats = tauxSyndicatsStr ? parseNum(tauxSyndicatsStr) / 100 : null;
    tauxEPCI = tauxEPCIStr ? parseNum(tauxEPCIStr) / 100 : null;
    tauxOM = tauxOMStr ? parseNum(tauxOMStr) / 100 : null;
    tauxGEMAPI = tauxGEMAPIStr ? parseNum(tauxGEMAPIStr) / 100 : null;
  }

  // A number-only row (label stripped) used for both the "Base" row and any
  // "Cotisation..." row — both share the same column layout as the taux row,
  // including omitting blank columns entirely (not even a 0).
  function parseNumberOnlyRow(line) {
    const tokens = line.trim().split(/\s+/);
    while (tokens.length && !/^[+\-]?\d/.test(tokens[0])) tokens.shift();
    if (tokens.length < 3 || tokens.length > 7) return null;
    const nums = tokens.map(tok => {
      const m = tok.match(/^[+\-]?(\d{1,5}(?:[,\.]\d{1,3})?)$/);
      return m ? parseNum(m[1]) : NaN;
    });
    return nums.some(isNaN) ? null : nums;
  }

  // Realign a number-only row (which skips blank columns just like the taux
  // row does) back onto the original 0-5 column indices using nonNullOrder.
  function realign(rowNums) {
    if (!rowNums || !nonNullOrder) return null;
    const byOrigIdx = {};
    nonNullOrder.forEach((origIdx, k) => { if (k < rowNums.length) byOrigIdx[origIdx] = rowNums[k]; });
    return byOrigIdx;
  }

  // ---- Base d'imposition ----
  let baseCommune = null, baseEPCI = null, baseOM = null, baseSyndicats = null, baseGEMAPI = null, baseAutre = null;
  const baseSearchStart = tauxRowIdx !== -1 ? tauxRowIdx : 0;
  const baseLineIdx = lines.findIndex((l, i) => {
    if (i < baseSearchStart) return false;
    const trimmed = l.trim();
    const looksLabeled = /base/i.test(trimmed);
    const looksBareNumbers = /^\d+(\s+\d+){2,6}$/.test(trimmed);
    return (looksLabeled || looksBareNumbers) && parseNumberOnlyRow(l);
  });
  if (baseLineIdx !== -1) {
    const baseNums = parseNumberOnlyRow(lines[baseLineIdx]);
    if (colOrder && nonNullOrder && baseNums.length === nonNullOrder.length) {
      const byIdx = realign(baseNums);
      baseCommune = byIdx[colOrder.communeIdx];
      baseEPCI = colOrder.epciIdx != null ? byIdx[colOrder.epciIdx] : null;
      baseOM = colOrder.omIdx != null ? byIdx[colOrder.omIdx] : null;
      baseSyndicats = colOrder.syndIdx != null && colOrder.syndIdx !== -1 ? byIdx[colOrder.syndIdx] : 0;
      baseGEMAPI = colOrder.gemapiIdx != null ? byIdx[colOrder.gemapiIdx] : null;
      baseAutre = colOrder.autreIdx != null ? byIdx[colOrder.autreIdx] : null;
    } else if (baseNums.length >= 1) {
      baseCommune = baseEPCI = baseOM = baseSyndicats = baseGEMAPI = baseAutre = baseNums[0];
    }
  } else {
    const baseFallback = (t.match(/Base\s*:?\s*(\d+(?:[,\.]\d{1,2})?)\s*[€¤]/i) || [])[1];
    if (baseFallback) baseCommune = baseEPCI = baseOM = baseSyndicats = baseGEMAPI = baseAutre = parseNum(baseFallback);
  }
  baseCommune = baseCommune != null ? Math.round(baseCommune) : null;
  const baseIntercommunalite = baseEPCI != null ? Math.round(baseEPCI) : baseCommune;

  // ---- Cotisation réelle par collectivité (post-lissage) ----
  // When lissage is active, base×taux no longer equals the actual amount
  // charged — DGFiP smooths it. The document usually prints the true,
  // already-smoothed per-category amounts on a "Cotisation…" row (e.g.
  // "Cotisationlissée 464 42 5 123 3 637", last number = grand total). When
  // found, these real figures are strictly more accurate for the exactness
  // check than recomputing base×taux ourselves — so they take priority.
  let cotisReel = null;
  for (let i = 0; i < lines.length; i++) {
    if (!/^Cotisation/i.test(lines[i].trim())) continue;
    const nums = parseNumberOnlyRow(lines[i]);
    if (!nums || !nonNullOrder) continue;
    if (nums.length === nonNullOrder.length || nums.length === nonNullOrder.length + 1) {
      cotisReel = { byIdx: realign(nums), total: nums.length === nonNullOrder.length + 1 ? nums[nums.length - 1] : null };
    }
  }

  // ---- Frais de gestion : formule légale fixe (CGI, art. 1641), pas une
  // donnée à extraire du texte. L'État prélève 3 % de la cotisation de
  // chaque collectivité, SAUF le syndicat de communes et la TEOM/OM qui
  // sont taxés à 8 % (frais d'assiette + de dégrèvement, taux "établissements
  // publics divers"). Ça ne dépend d'aucune donnée externe et ça ne peut pas
  // devenir obsolète (le taux légal ne change pas d'une année à l'autre).
  //
  // Pour la cotisation de départ, on préfère les montants RÉELLEMENT imprimés
  // par catégorie (via cotisReel) au calcul base×taux : quand un lissage est
  // actif, le montant réellement appelé diverge légitimement du calcul brut
  // (la hausse est étalée dans le temps) — recalculer nous-mêmes créerait un
  // écart artificiel là où il n'y en a pas.
  const cotis = (base, taux) => (base != null && taux != null) ? base * taux : null;
  const reel = (origIdx) => (cotisReel && origIdx != null && origIdx !== -1 && cotisReel.byIdx[origIdx] != null) ? cotisReel.byIdx[origIdx] : null;
  const cotisCommuneCalc = colOrder ? (reel(colOrder.communeIdx) ?? cotis(baseCommune, tauxCommune)) : cotis(baseCommune, tauxCommune);
  const cotisEPCICalc = colOrder ? (reel(colOrder.epciIdx) ?? cotis(baseEPCI ?? baseCommune, tauxEPCI)) : cotis(baseEPCI ?? baseCommune, tauxEPCI);
  const cotisOMCalc = colOrder ? (reel(colOrder.omIdx) ?? cotis(baseOM ?? baseCommune, tauxOM)) : cotis(baseOM ?? baseCommune, tauxOM);
  const cotisSyndicatCalc = colOrder ? (reel(colOrder.syndIdx) ?? cotis(baseSyndicats ?? baseCommune, tauxSyndicats)) : cotis(baseSyndicats ?? baseCommune, tauxSyndicats);
  const cotisGEMAPICalc = colOrder ? (reel(colOrder.gemapiIdx) ?? cotis(baseGEMAPI ?? baseCommune, tauxGEMAPI)) : cotis(baseGEMAPI ?? baseCommune, tauxGEMAPI);
  const cotisAutreCalc = colOrder ? (reel(colOrder.autreIdx) ?? cotis(baseAutre ?? baseCommune, tauxAutre)) : cotis(baseAutre ?? baseCommune, tauxAutre);

  const tauxReduit = [cotisCommuneCalc, cotisEPCICalc, cotisGEMAPICalc, cotisAutreCalc].filter(v => v != null);
  const tauxEleve = [cotisOMCalc, cotisSyndicatCalc].filter(v => v != null);
  const fraisGestionCalc = (tauxReduit.length || tauxEleve.length)
    ? Math.round(tauxReduit.reduce((a, b) => a + b, 0) * 0.03 + tauxEleve.reduce((a, b) => a + b, 0) * 0.08)
    : null;

  // ---- Cotisations N-1 / N ----
  // Some avis spell this out explicitly ("Cotisation 2024 : X€ / Cotisation
  // 2025 : Y€"); others print a full per-category breakdown with a grand
  // total (cotisReel.total) — prefer whichever is available.
  const cotisPairMatch = t.match(/Cotisation\s*(\d{4})[^\d€¤]*(\d+(?:[,\.]\d{1,2})?)\s*[€¤].{0,30}?Cotisation\s*(\d{4})[^\d€¤]*(\d+(?:[,\.]\d{1,2})?)\s*[€¤]/i);
  let cotisationCommune2024 = null, cotisationLisseeCommune2025 = null;
  if (cotisPairMatch) {
    cotisationCommune2024 = Math.round(parseNum(cotisPairMatch[2]));
    cotisationLisseeCommune2025 = Math.round(parseNum(cotisPairMatch[4]));
  } else {
    cotisationCommune2024 = null;
    cotisationLisseeCommune2025 = cotisReel?.total != null ? Math.round(cotisReel.total) : null;
  }

  // ---- Montant total ----
  const montantStr = findValue(lines, [/Montant\s+de\s+(vos|votre)\s+tax(es?)?\s+fonci.re/i, /Montant\s+de\s+votre\s+imp.t/i, /Montant\s+total/i], NUM_RE)
    || (t.match(/Somme\s+.+?(\d+(?:[,\.]\d{1,2})?)\s*[€¤]/i) || [])[1];
  const montantTotal = montantStr ? parseNum(montantStr) : null;

  // ---- Frais de gestion ----
  // Prefer the computed value (exact, formula-based, works even when the
  // document never spells out "Frais de gestion" as its own line — as with
  // the avis d'échéances). Only fall back to a labeled-text search if we
  // couldn't compute it (missing base or taux for every category).
  const fraisStr = findValue(lines, [/Frais\s+de\s+gestion/i], NUM_RE);
  const fraisGestion = fraisGestionCalc != null ? fraisGestionCalc : (fraisStr ? Math.round(parseNum(fraisStr)) : null);

  // ---- Lissage ----
  const lissageMatch = t.match(/lissage\s+de\s+\+?\s*(\d+)\s*[€¤]?\s*par\s+an/i)
    || t.match(/lissage.*?(\d+)\s*[€¤]\s*par\s+an/i);
  const lissage = !!lissageMatch || /lissage/i.test(t);
  const lissageMontantAnnuel = lissageMatch ? parseInt(lissageMatch[1]) : null;
  const lissageDebutMatch = t.match(/lissage.*?en\s+(\d{4})/i) || t.match(/calcul.*?en\s+(\d{4})/i);
  const lissageDebut = lissageDebutMatch ? parseInt(lissageDebutMatch[1]) : null;
  const lissageDureeMatch = t.match(/(\d+)\s+ans/i);
  const lissageDuree = lissageDureeMatch ? parseInt(lissageDureeMatch[1]) : null;

  // Référence administrative (identifie précisément le local pour la demande de fiche d'évaluation cadastrale)
  const refMatch = t.match(/R[ée]f[ée]rences?\s+administratives?\s*:?\s*((?:\d{1,3}\s+){3,7}[A-Z](?:\s+[A-Z])?)/i);
  const referenceAdministrative = refMatch ? refMatch[1].trim().replace(/\s+/g, " ") : null;

  // ---- Total recalculé, exact ----
  // Round each category's cotisation individually (DGFiP rounds per line
  // before summing, which is why a naive "round the grand total" approach
  // drifts by a few euros), then add the legally-fixed frais de gestion.
  const cotisationsRounded = [cotisCommuneCalc, cotisEPCICalc, cotisOMCalc, cotisSyndicatCalc, cotisGEMAPICalc, cotisAutreCalc]
    .filter(v => v != null).map(v => Math.round(v));
  const sousTotalCotisations = cotisationsRounded.length ? cotisationsRounded.reduce((a, b) => a + b, 0) : null;
  const montantRecalcule = (sousTotalCotisations != null && fraisGestion != null) ? sousTotalCotisations + fraisGestion : null;

  return {
    entreprise, adresse, commune, departement, annee, referenceAdministrative,
    baseCommune, baseIntercommunalite,
    tauxCommune, tauxEPCI, tauxOM, tauxSyndicats, tauxGEMAPI, tauxAutre,
    cotisationCommune2024, cotisationLisseeCommune2025,
    montantTotal, fraisGestion,
    sousTotalCotisations, montantRecalcule,
    lissage, lissageMontantAnnuel, lissageDebut, lissageDuree
  };
}

// ---- Pure JS letter template — zero API ----
function generateLetter(d, anomalies) {
  const today = new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  return `[NOM MANDATAIRE / CABINET COMPTABLE]
[Adresse du mandataire]
[Code postal, Ville]
[Email / Téléphone]
N° Mandat / SIRET : [À COMPLÉTER]

À l'attention du
Centre des Impôts Fonciers (CDIF / SDIF)
Département ${d.departement || "—"}

Fait à [Ville], le ${today}

Objet : Demande de fiche d'évaluation détaillée — Taxe foncière sur les propriétés bâties ${d.annee || 2025}
Réf. bien : ${d.adresse || "—"}, ${d.commune || "—"} (${d.departement || "—"})
${d.referenceAdministrative ? `Référence administrative (parcelle) : ${d.referenceAdministrative}\n` : ""}Contribuable : ${d.entreprise || "—"}

Madame, Monsieur,

Mandaté(e) par ${d.entreprise || "[NOM DU CONTRIBUABLE]"}, propriétaire du bien sis au ${d.adresse || "—"}, ${d.commune || "—"}, nous nous permettons de vous adresser la présente afin d'obtenir, dans un souci de transparence et conformément aux droits garantis par le code des relations entre le public et l'administration (CRPA, article L.312-1 et suivants), le détail complet du calcul ayant conduit à l'établissement de la taxe foncière sur les propriétés bâties pour l'année ${d.annee || 2025}.

L'avis d'imposition fait état des éléments suivants :
- Base d'imposition (commune) : ${d.baseCommune ? d.baseCommune + " €" : "—"}
- Montant total de l'impôt : ${d.montantTotal ? d.montantTotal + " €" : "—"}
${d.lissage ? `- Un lissage de +${d.lissageMontantAnnuel ?? "?"}€/an est mentionné depuis ${d.lissageDebut ?? "?"}${d.lissageDuree ? ` sur une période de ${d.lissageDuree} ans` : ""}.` : ""}

Après vérification, ${anomalies ? `les points suivants appellent une clarification : ${anomalies}.` : "le calcul arithmétique de l'avis (base × taux, frais de gestion) est cohérent. Nous souhaitons néanmoins nous assurer que la valeur locative retenue reflète l'état actuel du bien, cet élément n'étant pas vérifiable depuis l'avis d'imposition seul."}

Dans ce cadre, nous vous demandons de bien vouloir nous communiquer :

1. La fiche d'évaluation détaillée du bien (extrait GMBI ou fiche d'évaluation cadastrale), incluant :
   - La catégorie tarifaire retenue,
   - Le secteur d'évaluation,
   - La surface pondérée et les coefficients appliqués,
   - Le tarif au m² de référence.

2. L'historique des bases d'imposition et des cotisations sur les 5 dernières années.

3. Le détail du mécanisme de lissage appliqué, si applicable, avec la date de fin prévue.

Nous restons à votre disposition pour tout renseignement complémentaire et vous remercions de l'attention portée à cette demande.

Veuillez agréer, Madame, Monsieur, l'expression de nos salutations distinguées.

[NOM MANDATAIRE / CABINET COMPTABLE]
[Signature]

---
Note : Ce courrier constitue une demande d'information (mandat léger). Il ne s'agit pas d'une réclamation formelle au sens des articles R*190-1 et R*196-2 du livre des procédures fiscales. Une réclamation éventuelle ferait l'objet d'un courrier distinct, après analyse de la fiche d'évaluation.`;
}

// ---- Mandat / procuration — pour que l'expert-comptable puisse agir au nom du client ----
function generateMandat(d) {
  const today = new Date().toLocaleDateString("fr-FR");
  return `MANDAT DE REPRÉSENTATION
Demande de fiche d'évaluation de la valeur locative — Taxe foncière sur les propriétés bâties

Je soussigné(e) [NOM, PRÉNOM DU CONTRIBUABLE]${d.entreprise ? ` (${d.entreprise})` : ""}, propriétaire du bien désigné ci-dessous, donne mandat à :

[NOM DU CABINET COMPTABLE / MANDATAIRE]
[Adresse du cabinet]
[N° SIREN / agrément le cas échéant]

pour me représenter auprès du Centre des Impôts Fonciers (CDIF) et de la Direction Générale des Finances Publiques (DGFiP), aux fins de :

1. Demander et recevoir en mon nom la fiche d'évaluation de la valeur locative (extrait GMBI ou fiche d'évaluation cadastrale) du bien désigné ci-après ;
2. Consulter le détail du calcul de la taxe foncière (base, catégorie, surface pondérée, coefficients appliqués) ;
3. Le cas échéant, engager en mon nom une démarche de réclamation ou de rectification auprès de l'administration fiscale, dans les conditions prévues par le livre des procédures fiscales.

Désignation du bien :
Adresse : ${d.adresse || "[ADRESSE DU BIEN]"}
Commune : ${d.commune || "[COMMUNE]"} (${d.departement || "[DÉPARTEMENT]"})
${d.referenceAdministrative ? `Référence administrative (parcelle) : ${d.referenceAdministrative}\n` : ""}Année d'imposition concernée : ${d.annee || 2025}

Ce mandat est valable pour la durée nécessaire à l'accomplissement des démarches ci-dessus et peut être révoqué à tout moment par écrit.

Fait à [Ville], le ${today}

Signature du mandant (contribuable) :                    Signature du mandataire (cabinet) :
[NOM, PRÉNOM]                                              [NOM DU CABINET]


---
Note : ce document est un modèle. Il doit être relu et, le cas échéant, adapté par un professionnel du droit ou de la comptabilité avant signature — notamment si le mandat doit couvrir une procédure contentieuse.`;
}

// ---- UI helpers ----
function eur(n) {
  if (n == null || isNaN(n)) return "—";
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
}
function pct(n) {
  if (n == null || isNaN(n)) return "—";
  return (n * 100).toFixed(2).replace(".", ",") + " %";
}

function ScoreBadge({ score }) {
  const cfg = score >= 60
    ? { label: "Anomalie probable", bg: "bg-red-50", border: "border-red-300", color: "text-red-700" }
    : score >= 35
    ? { label: "À vérifier", bg: "bg-amber-50", border: "border-amber-300", color: "text-amber-700" }
    : { label: "Cohérent", bg: "bg-green-50", border: "border-green-300", color: "text-green-700" };
  return (
    <div className={`rounded-xl border ${cfg.bg} ${cfg.border} p-4 flex items-center justify-between`}>
      <div>
        <div className={`text-lg font-bold ${cfg.color}`}>{cfg.label}</div>
        <div className="text-xs text-gray-500 mt-0.5">Probabilité d'erreur de calcul</div>
      </div>
      <div className={`text-4xl font-mono font-bold ${cfg.color}`}>{score}%</div>
    </div>
  );
}

function Check({ label, status, detail }) {
  const icon = status === "ok"
    ? <CheckCircle2 size={16} className="text-green-500 shrink-0 mt-0.5" />
    : status === "flag"
    ? <AlertTriangle size={16} className="text-red-500 shrink-0 mt-0.5" />
    : <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />;
  return (
    <div className="flex gap-2.5 py-2.5 border-b border-gray-100 last:border-0">
      {icon}
      <div>
        <div className="text-sm font-medium text-gray-800">{label}</div>
        {detail && <div className="text-xs text-gray-500 mt-0.5 leading-relaxed">{detail}</div>}
      </div>
    </div>
  );
}

function Row({ label, value, flag }) {
  return (
    <div className="flex justify-between py-1.5 border-b border-gray-50 last:border-0">
      <span className="text-xs text-gray-400 uppercase tracking-wide">{label}</span>
      <span className={`text-sm font-mono ${flag ? "text-red-600 font-bold" : "text-gray-800"}`}>{value}</span>
    </div>
  );
}

const TYPES_BIEN = ["Appartement", "Maison", "Local commercial", "Bureau", "Autre"];
const ETATS_BIEN = ["Bon état", "État moyen", "Vétuste / à rénover"];
const CONFORT_ELEMENTS = [
  { id: "chauffageCentral", label: "Chauffage central" },
  { id: "salleBain", label: "Salle de bain (baignoire/douche)" },
  { id: "wcIndividuel", label: "WC individuels" },
  { id: "toutALegout", label: "Tout-à-l'égout" },
  { id: "ascenseur", label: "Ascenseur (immeuble collectif)" },
];
const DEPENDANCES_ELEMENTS = [
  { id: "garage", label: "Garage" },
  { id: "cave", label: "Cave" },
  { id: "piscine", label: "Piscine" },
  { id: "terrasseBalcon", label: "Terrasse / balcon" },
];
const EMPTY_BIEN = { superficie: "", type: "", etat: "", anneeConstruction: "", confort: [], dependances: [] };

// ---- Main component ----
export default function TFAudit() {
  const [phase, setPhase] = useState("upload");
  const [fileName, setFileName] = useState(null);
  const [fileData, setFileData] = useState(null);
  const [log, setLog] = useState([]);
  const [extracted, setExtracted] = useState(null); // raw parsed data, before bien-form
  const [bien, setBien] = useState(EMPTY_BIEN);
  const [result, setResult] = useState(null);
  const [letter, setLetter] = useState(null);
  const [mandat, setMandat] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [leadEmail, setLeadEmail] = useState("");
  const [leadSent, setLeadSent] = useState(false);

  const addLog = msg => setLog(p => [...p, msg]);

  function handleFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    const isPdf = f.type === "application/pdf";
    const reader = new FileReader();
    reader.onload = () => setFileData({ base64: reader.result.split(",")[1], isPdf });
    reader.readAsDataURL(f);
  }

  // Étape 1 : upload + extraction du PDF, puis on passe au formulaire court (étape 2)
  async function run() {
    setPhase("running"); setLog([]); setResult(null); setLetter(null); setErrorMsg(null);
    try {
      let text = "";
      if (fileData?.isPdf) {
        addLog("Extraction du texte PDF…");
        text = await extractPdfText(fileData.base64);
        console.log('RAW PDF TEXT:', text);
        addLog(`${text.length} caractères extraits`);
      } else {
        addLog("Mode démonstration (SCI Place de la Croix)");
        text = "DEMO";
      }

      addLog("Analyse des données…");
      let d;
      if (text === "DEMO") {
        d = {
          entreprise: "SCI PLACE DE LA CROIX", adresse: "240 CHE DE MARRET",
          commune: "VILLEBRUMIER", departement: "82", annee: 2025,
          baseCommune: 936, baseIntercommunalite: 898,
          tauxCommune: 0.5048, tauxEPCI: 0.0477, tauxOM: 0.1386,
          tauxSyndicats: 0.0061, tauxGEMAPI: 0.00314,
          cotisationCommune2024: 454, cotisationLisseeCommune2025: 464,
          montantTotal: 662, fraisGestion: 25,
          sousTotalCotisations: 648, montantRecalcule: 673,
          lissage: true, lissageMontantAnnuel: 10, lissageDebut: 2017, lissageDuree: 10
        };
      } else {
        d = extractData(text);
      }

      setExtracted(d);
      setPhase("bien");
    } catch (e) {
      setErrorMsg(e?.message || String(e));
      setPhase("error");
    }
  }

  // Étape 2 : formulaire court (5 champs) → étape 3 : score anomalie
  function submitBien(e) {
    e?.preventDefault();
    const d = extracted;
    if (!d) return;

    addLog("Vérifications arithmétiques…");
    const totalRecalc = d.montantRecalcule;
    const ecartMontant = totalRecalc != null && d.montantTotal ? d.montantTotal - totalRecalc : null;
    const revaloOff = d.annee === 2025 ? 0.039 : 0.008;
    const c24 = d.cotisationCommune2024, c25 = d.cotisationLisseeCommune2025;
    const evo = c24 && c25 ? (c25 - c24) / c24 : null;
    const ecartEvo = evo != null ? evo - revaloOff : null;

    const checks = [];
    let score = 0;

    if (d.lissage) {
      score += 30;
      checks.push({ id: "lissage", status: "flag", label: "Lissage actif détecté",
        detail: `+${d.lissageMontantAnnuel ?? "?"}€/an depuis ${d.lissageDebut ?? "?"}${d.lissageDuree ? ` sur ${d.lissageDuree} ans` : ""}. Ce mécanisme opaque augmente artificiellement la cotisation — à vérifier si la période est encore en cours et si la durée est correctement appliquée.` });
    }

    if (ecartMontant != null) {
      const flag = Math.abs(ecartMontant) > 15;
      if (flag) score += 35;
      checks.push({ id: "montant", status: flag ? "flag" : "ok",
        label: "Cohérence montant total",
        detail: flag
          ? `Affiché ${eur(d.montantTotal)} ≠ recalculé ${eur(totalRecalc)}. Écart : ${eur(ecartMontant)}.`
          : `Montant affiché (${eur(d.montantTotal)}) cohérent avec le recalcul (${eur(totalRecalc)}).` });
    }

    if (evo != null) {
      const flag = Math.abs(ecartEvo) > 0.03;
      if (flag) score += 25;
      checks.push({ id: "evolution", status: flag ? "flag" : "ok",
        label: "Évolution cotisation N-1 → N",
        detail: flag
          ? `Hausse de ${pct(evo)} vs revalorisation officielle ${d.annee} (${pct(revaloOff)}). Écart de ${pct(ecartEvo)}.`
          : `Hausse de ${pct(evo)} cohérente avec la revalorisation officielle ${d.annee} (${pct(revaloOff)}).` });
    }

    // État déclaratif du bien (formulaire court) — signal supplémentaire, pas encore vérifiable
    // automatiquement (nécessite la fiche d'évaluation cadastrale), mais on l'expose comme point de contrôle qualitatif
    // ancré sur les vrais critères de la surface pondérée (art. 324 T-U, annexe III CGI), pas des
    // catégories génériques — pour donner une hypothèse concrète à vérifier plutôt qu'un flag vague.
    const confortManquants = CONFORT_ELEMENTS.filter(el => !bien.confort.includes(el.id)).map(el => el.label);
    const bienAncien = bien.anneeConstruction && parseInt(bien.anneeConstruction) < 1975;
    const bienVetuste = bien.etat === "Vétuste / à rénover";
    if (bienVetuste || bienAncien) {
      score += 10;
      checks.push({ id: "vetuste", status: "flag", label: "Écart possible sur la surface pondérée",
        detail: `Bien ${bien.anneeConstruction ? `construit en ${bien.anneeConstruction} ` : ""}déclaré en "${bien.etat || "état non précisé"}"${confortManquants.length ? `, sans ${confortManquants.slice(0, 2).join(" ni ")}` : ""}. La valeur locative repose sur une surface pondérée (état d'entretien + éléments de confort) fixée en 1970 et rarement mise à jour depuis — un abattement pour vétusté ou l'absence de certains éléments de confort dans le calcul officiel peut ne pas être reflété. À vérifier sur la fiche d'évaluation cadastrale, à demander au CDIF.` });
    }

    checks.push({ id: "taux", status: "info",
      label: "Taux communal — vérification manuelle",
      detail: `${pct(d.tauxCommune)} affiché pour ${d.commune || "?"} en ${d.annee}. À comparer au taux officiel voté (disponible sur impots.gouv.fr ou auprès de la mairie).` });

    score = Math.min(100, score);
    const trisAnnuel = ecartMontant != null && ecartMontant > 5 ? ecartMontant : 0;
    const troPerçu3Ans = Math.round(trisAnnuel * 3);

    setResult({ d, bien, checks, score, totalRecalc, ecartMontant, evo, revaloOff, troPerçu3Ans });

    const anomalies = checks.filter(c => c.status === "flag").map(c => c.label).join(", ");
    setLetter(generateLetter(d, anomalies));
    setMandat(generateMandat(d));

    setPhase("done");
  }

  function submitLead(e) {
    e?.preventDefault();
    if (!leadEmail) return;
    // Pas d'API pour l'instant : capture front uniquement (à brancher sur Brevo/CRM).
    setLeadSent(true);
  }

  function reset() {
    setPhase("upload"); setFileName(null); setFileData(null);
    setLog([]); setExtracted(null); setBien(EMPTY_BIEN);
    setResult(null); setLetter(null); setMandat(null); setErrorMsg(null);
    setLeadEmail(""); setLeadSent(false);
  }

  function downloadText(content, filename) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-5 py-4 flex items-center justify-between sticky top-0 z-10">
        <div>
          <div className="font-bold text-gray-900">Audit Taxe Foncière</div>
          <div className="text-xs text-gray-400">Explain Legal · TFPB v0.4</div>
        </div>
        {phase !== "upload" && (
          <button onClick={reset} className="text-xs text-blue-600 underline">Recommencer</button>
        )}
      </div>

      <div className="max-w-lg mx-auto px-4 py-6 space-y-4">

        {phase === "upload" && (
          <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
            <div>
              <h1 className="text-lg font-bold text-gray-900">Votre taxe foncière est-elle correcte ?</h1>
              <p className="text-sm text-gray-500 mt-1 leading-relaxed">Uploadez l'avis PDF (depuis impots.gouv.fr). L'outil détecte les anomalies et génère le courrier pour demander le détail du calcul à l'administration.</p>
            </div>
            <label htmlFor="file-up" className="block border-2 border-dashed border-gray-200 hover:border-blue-400 rounded-xl p-6 text-center cursor-pointer transition-colors">
              <input id="file-up" type="file" accept=".pdf,image/*" onChange={handleFile} className="hidden" />
              <Upload size={22} className="mx-auto mb-2 text-gray-400" />
              <p className="text-sm font-medium text-gray-700">{fileName || "Choisir l'avis de taxe foncière"}</p>
              <p className="text-xs text-gray-400 mt-1">PDF natif depuis impots.gouv.fr</p>
            </label>
            <button onClick={run} className="w-full bg-gray-900 text-white py-3 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 hover:bg-gray-700 transition-colors">
              Lancer l'analyse <ChevronRight size={16} />
            </button>
            {!fileData && <p className="text-center text-xs text-gray-400">Sans fichier : mode démonstration</p>}
          </div>
        )}

        {phase === "running" && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-3 mb-4">
              <Loader2 size={20} className="animate-spin text-blue-500" />
              <span className="font-semibold text-gray-800 text-sm">Analyse en cours…</span>
            </div>
            <div className="space-y-2">
              {log.map((l, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-gray-500">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-300" />{l}
                </div>
              ))}
            </div>
          </div>
        )}

        {phase === "bien" && extracted && (
          <form onSubmit={submitBien} className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
            <div>
              <h1 className="text-lg font-bold text-gray-900">Votre bien</h1>
              <p className="text-sm text-gray-500 mt-1 leading-relaxed">5 infos rapides pour affiner le score. Bien détecté à {extracted.commune || "l'adresse indiquée sur l'avis"}.</p>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Superficie (m²)</label>
              <input type="number" min="1" required value={bien.superficie}
                onChange={e => setBien(b => ({ ...b, superficie: e.target.value }))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400" placeholder="ex : 85" />
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Type de bien</label>
              <div className="grid grid-cols-2 gap-2">
                {TYPES_BIEN.map(opt => (
                  <button type="button" key={opt} onClick={() => setBien(b => ({ ...b, type: opt }))}
                    className={`text-sm py-2.5 rounded-lg border transition-colors ${bien.type === opt ? "bg-gray-900 text-white border-gray-900" : "border-gray-200 text-gray-700 hover:border-gray-400"}`}>
                    {opt}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1.5">État général</label>
              <div className="grid grid-cols-1 gap-2">
                {ETATS_BIEN.map(opt => (
                  <button type="button" key={opt} onClick={() => setBien(b => ({ ...b, etat: opt }))}
                    className={`text-sm py-2.5 rounded-lg border text-left px-3 transition-colors ${bien.etat === opt ? "bg-gray-900 text-white border-gray-900" : "border-gray-200 text-gray-700 hover:border-gray-400"}`}>
                    {opt}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Éléments de confort présents</label>
              <p className="text-xs text-gray-400 mb-2 leading-relaxed">Ces éléments entrent directement dans le calcul officiel de la surface pondérée (art. 324 T-U, annexe III CGI) — pas le DPE, qui n'y figure pas.</p>
              <div className="grid grid-cols-1 gap-2">
                {CONFORT_ELEMENTS.map(({ id, label }) => {
                  const checked = bien.confort.includes(id);
                  return (
                    <button type="button" key={id}
                      onClick={() => setBien(b => ({ ...b, confort: checked ? b.confort.filter(c => c !== id) : [...b.confort, id] }))}
                      className={`text-sm py-2.5 rounded-lg border text-left px-3 flex items-center justify-between transition-colors ${checked ? "bg-gray-900 text-white border-gray-900" : "border-gray-200 text-gray-700 hover:border-gray-400"}`}>
                      {label}
                      {checked && <CheckCircle2 size={15} />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Dépendances existantes</label>
              <p className="text-xs text-gray-400 mb-2 leading-relaxed">Une dépendance démolie ou jamais retirée du calcul officiel est une source fréquente d'écart.</p>
              <div className="grid grid-cols-2 gap-2">
                {DEPENDANCES_ELEMENTS.map(({ id, label }) => {
                  const checked = bien.dependances.includes(id);
                  return (
                    <button type="button" key={id}
                      onClick={() => setBien(b => ({ ...b, dependances: checked ? b.dependances.filter(c => c !== id) : [...b.dependances, id] }))}
                      className={`text-sm py-2.5 rounded-lg border text-left px-3 flex items-center justify-between transition-colors ${checked ? "bg-gray-900 text-white border-gray-900" : "border-gray-200 text-gray-700 hover:border-gray-400"}`}>
                      {label}
                      {checked && <CheckCircle2 size={15} />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Année construction</label>
              <input type="number" min="1800" max="2026" value={bien.anneeConstruction}
                onChange={e => setBien(b => ({ ...b, anneeConstruction: e.target.value }))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400" placeholder="ex : 1998" />
            </div>

            <button type="submit" className="w-full bg-gray-900 text-white py-3 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 hover:bg-gray-700 transition-colors">
              Voir mon score d'anomalie <ChevronRight size={16} />
            </button>
          </form>
        )}

        {phase === "error" && (
          <div className="bg-white rounded-xl border border-red-200 p-6 space-y-3">
            <div className="flex items-center gap-2">
              <XCircle size={18} className="text-red-500" />
              <span className="font-bold text-red-700 text-sm">Erreur d'analyse</span>
            </div>
            <p className="text-xs font-mono text-red-600 bg-red-50 rounded-lg p-3 leading-relaxed">{errorMsg}</p>
            <button onClick={reset} className="w-full border border-gray-200 text-gray-700 py-2.5 rounded-xl text-sm hover:bg-gray-50">Réessayer</button>
          </div>
        )}

        {phase === "done" && result && (
          <>
            <ScoreBadge score={result.score} />

            <div className="bg-blue-50 border border-blue-100 rounded-xl p-3.5">
              <p className="text-xs font-semibold text-blue-700 mb-1">Ce qui est vérifié à l'euro près</p>
              <p className="text-xs text-blue-600 leading-relaxed">Le calcul base × taux + frais de gestion légaux (art. 1641 CGI) est recalculé et comparé au montant affiché sur l'avis.</p>
              <p className="text-xs font-semibold text-blue-700 mt-2 mb-1">Ce qui reste à vérifier manuellement</p>
              <p className="text-xs text-blue-600 leading-relaxed">Que les taux appliqués sont bien les taux votés cette année par les collectivités (impots.gouv.fr / mairie), et que la valeur locative elle-même est correcte (fiche d'évaluation cadastrale, à demander gratuitement au CDIF).</p>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Bien analysé</p>
              <Row label="Propriétaire" value={result.d.entreprise || "—"} />
              <Row label="Adresse" value={result.d.adresse || "—"} />
              <Row label="Commune" value={`${result.d.commune || "—"} (${result.d.departement || "?"})`} />
              <Row label="Année" value={result.d.annee} />
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Chiffres clés</p>
              <Row label="Base commune" value={eur(result.d.baseCommune)} />
              <Row label="Taux commune" value={pct(result.d.tauxCommune)} />
              <Row label="Taux EPCI" value={pct(result.d.tauxEPCI)} />
              <Row label="Taux ordures" value={pct(result.d.tauxOM)} />
              <Row label="Taux GEMAPI" value={pct(result.d.tauxGEMAPI)} />
              <Row label="Frais de gestion (calculé, art. 1641 CGI)" value={eur(result.d.fraisGestion)} />
              <Row label="Montant affiché" value={eur(result.d.montantTotal)} flag={result.ecartMontant != null && Math.abs(result.ecartMontant) > 15} />
              <Row label="Recalculé (base×taux + frais gestion)" value={eur(result.totalRecalc)} flag={result.ecartMontant != null && Math.abs(result.ecartMontant) > 15} />
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Points de contrôle</p>
              {result.checks.map(c => <Check key={c.id} {...c} />)}
            </div>

            {result.troPerçu3Ans > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-600 mb-1">Trop-perçu estimé sur 3 ans</p>
                <p className="text-2xl font-bold text-amber-700">{eur(result.troPerçu3Ans)}</p>
                <p className="text-xs text-amber-600 mt-1 leading-relaxed">Basé sur l'écart annuel constaté ({eur(result.ecartMontant)}) projeté sur 3 ans — c'est le délai de réclamation possible auprès de l'administration.</p>
              </div>
            )}

            {letter && (
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Courrier — demande de fiche d'évaluation cadastrale</p>
                  <button onClick={() => downloadText(letter, "demande-fiche-evaluation-cadastrale.txt")} className="flex items-center gap-1.5 text-xs border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50 text-gray-700">
                    <Download size={12} /> Télécharger
                  </button>
                </div>
                <pre className="text-xs font-mono text-gray-600 whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">{letter}</pre>
                <p className="text-xs text-gray-400 mt-3 leading-relaxed border-t border-gray-100 pt-3">Demande d'information uniquement — pas une contestation formelle. À valider avec votre expert-comptable avant envoi.</p>
              </div>
            )}

            {mandat && (
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Modèle de mandat / procuration</p>
                  <button onClick={() => downloadText(mandat, "mandat-procuration.txt")} className="flex items-center gap-1.5 text-xs border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50 text-gray-700">
                    <Download size={12} /> Télécharger
                  </button>
                </div>
                <pre className="text-xs font-mono text-gray-600 whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">{mandat}</pre>
                <p className="text-xs text-gray-400 mt-3 leading-relaxed border-t border-gray-100 pt-3">Modèle à faire signer par le client pour que votre cabinet puisse agir en son nom auprès du CDIF. À faire relire par un professionnel avant usage.</p>
              </div>
            )}

            {result.score === 0 && (
              <div className="bg-green-50 border border-green-200 rounded-xl p-4">
                <div className="flex items-center gap-2">
                  <CheckCircle2 size={16} className="text-green-600" />
                  <p className="text-sm font-medium text-green-700">Arithmétique cohérente</p>
                </div>
                <p className="text-xs text-green-600 mt-1 leading-relaxed">Aucune anomalie sur ce qui est vérifiable dans l'avis. Cela ne garantit pas que la valeur locative soit correcte — 30 à 40% des erreurs réelles se trouvent là, invisibles depuis l'avis seul. Seule la fiche d'évaluation cadastrale le confirme.</p>
              </div>
            )}

            <div className="bg-gray-900 rounded-xl p-5 text-white">
              {!leadSent ? (
                <form onSubmit={submitLead} className="space-y-3">
                  <p className="text-sm font-bold">
                    {result.score > 0 ? "On s'occupe de tout, vous ne payez qu'en cas de succès" : "Vérifier aussi la valeur locative ?"}
                  </p>
                  <p className="text-xs text-gray-300 leading-relaxed">
                    {result.score > 0
                      ? "49€ de frais de dossier + 30% du remboursement obtenu. Notre expert-comptable partenaire monte le dossier, dépose la demande auprès du CDIF et suit le dégrèvement jusqu'au bout."
                      : "L'arithmétique est saine, mais la vraie source d'erreur (surface, confort, état) reste invisible depuis l'avis. 49€ de frais de dossier + 30% du remboursement obtenu si un écart réel est trouvé sur la valeur locative — rien si aucun écart n'est confirmé."}
                  </p>
                  <div className="flex gap-2">
                    <input type="email" required value={leadEmail} onChange={e => setLeadEmail(e.target.value)}
                      placeholder="votre@email.fr"
                      className="flex-1 bg-white/10 border border-white/20 rounded-lg px-3 py-2.5 text-sm placeholder-gray-400 focus:outline-none focus:border-white/50" />
                    <button type="submit" className="bg-white text-gray-900 px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-gray-100 whitespace-nowrap">
                      Être recontacté
                    </button>
                  </div>
                </form>
              ) : (
                <div className="flex items-center gap-2">
                  <CheckCircle2 size={18} className="text-green-400" />
                  <p className="text-sm">Merci ! On revient vers vous sous 48h.</p>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
