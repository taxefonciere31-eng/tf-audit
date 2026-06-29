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
    text += content.items.map(x => x.str).join(" ") + "\n";
  }
  return text;
}

// ---- Pure JS extraction from PDF text ----
function parseNum(str) {
  if (!str) return null;
  const n = parseFloat(str.replace(/\s/g, "").replace(",", "."));
  return isNaN(n) ? null : n;
}

function extractData(text) {
  const t = text.replace(/\s+/g, " ");

  // Helper: find number after keyword
  const after = (kw, offset = 0) => {
    const re = new RegExp(kw + "[\\s:]*([\\d\\s,\\.]+)", "i");
    const m = t.match(re);
    if (!m) return null;
    return parseNum(m[1 + offset]);
  };

  // Helper: find percentage (e.g. "50,48 %")
  const allPcts = [...t.matchAll(/(\d{1,3}[,\.]\d{1,3})\s*%/g)].map(m => parseNum(m[1]) / 100);
  const allInts = [...t.matchAll(/\b(\d{2,6})\b/g)].map(m => parseInt(m[1]));

  // Propriétaire
  const proprioMatch = t.match(/SCI\s+[\w\s]+|SARL\s+[\w\s]+|SAS\s+[\w\s]+|EURL\s+[\w\s]+|M[MR]\.\s+[\w\s]+/i);
  const entreprise = proprioMatch ? proprioMatch[0].trim().slice(0, 40) : null;

  // Commune
  const communeMatch = t.match(/commune\s+d.imposition\s*:?\s*(\d+)?\s*([A-Z][A-Z\-\s]+)/i)
    || t.match(/Taxes fonci.res.*?commune\s+de\s+([A-Z][A-Z\-\s]+)/i);
  const commune = communeMatch ? communeMatch[communeMatch.length - 1].trim().slice(0, 30) : null;

  // Département
  const deptMatch = t.match(/[Dd].partement\s+d.imposition\s*:?\s*(\d{2,3})/);
  const departement = deptMatch ? deptMatch[1] : null;

  // Adresse du bien (240 CHE DE MARRET style)
  const adresseMatch = t.match(/(\d{1,4}\s+(?:CHE|RUE|AV|BD|IMP|ALL|PL)\s+[\w\s]+?)(?=\s{2,}|\n)/i);
  const adresse = adresseMatch ? adresseMatch[1].trim().slice(0, 60) : null;

  // Année
  const anneeMatch = t.match(/Taxes fonci.res\s+(\d{4})/i) || t.match(/pour\s+(\d{4})/i);
  const annee = anneeMatch ? parseInt(anneeMatch[1]) : 2025;

  // Taux — look for pattern "50,48 %" in sequence commune/interco/OM/syndicats/GEMAPI
  // On the DGFiP avis, taux appear twice (2024 row then 2025 row)
  // We want taux 2025 (second occurrence of each)
  const tauxAll = [...t.matchAll(/(\d{1,3}[,\.]\d{2,3})\s*%/g)].map(m => parseNum(m[1]) / 100);
  
  // Typically: taux commune 2024, taux commune 2025, taux interco 2024, taux interco 2025...
  // But layout varies — use positional heuristic
  const tauxCommune = tauxAll.length > 0 ? tauxAll[0] : null;
  const tauxEPCI = tauxAll.length > 2 ? tauxAll[2] : null;
  const tauxOM = tauxAll.length > 4 ? tauxAll[4] : null;
  const tauxSyndicats = tauxAll.length > 6 ? tauxAll[6] : null;
  const tauxGEMAPI = tauxAll.length > 8 ? tauxAll[8] : null;

  // Bases — integers in the 100–99999 range appearing after "Base" context
  const baseMatch = t.match(/Base\s+(\d{3,6})/i);
  const baseCommune = baseMatch ? parseInt(baseMatch[1]) : null;

  // Cotisations — look for Cotisation 2024 / 2025
  const cotis2024Match = t.match(/Cotisation\s+2024.*?(\d{3,5})/i)
    || t.match(/2024.*?(\d{3,5})\s/);
  const cotisationCommune2024 = cotis2024Match ? parseInt(cotis2024Match[1]) : null;

  const cotis2025Match = t.match(/Cotisation\s+2025.*?(\d{3,5})/i)
    || t.match(/Cotisation\s+liss.e.*?(\d{3,5})/i);
  const cotisationLisseeCommune2025 = cotis2025Match ? parseInt(cotis2025Match[1]) : null;

  // Montant total
  const montantMatch = t.match(/Montant\s+de\s+votre\s+imp.t\s+(\d{3,6})/i)
    || t.match(/Somme\s+.+\s+(\d{3,6}[,\.]?\d{0,2})\s*€/i);
  const montantTotal = montantMatch ? parseNum(montantMatch[1]) : null;

  // Frais gestion
  const fraisMatch = t.match(/Frais\s+de\s+gestion.*?(\d{1,4})/i);
  const fraisGestion = fraisMatch ? parseInt(fraisMatch[1]) : null;

  // Lissage
  const lissageMatch = t.match(/lissage\s+de\s+\+?\s*(\d+)\s*€?\s*par\s+an/i)
    || t.match(/lissage.*?(\d+)\s*€\s*par\s+an/i);
  const lissage = !!lissageMatch || /lissage/i.test(t);
  const lissageMontantAnnuel = lissageMatch ? parseInt(lissageMatch[1]) : null;
  const lissageDebutMatch = t.match(/lissage.*?en\s+(\d{4})/i) || t.match(/calcul.*?en\s+(\d{4})/i);
  const lissageDebut = lissageDebutMatch ? parseInt(lissageDebutMatch[1]) : null;
  const lissageDureeMatch = t.match(/(\d+)\s+ans/i);
  const lissageDuree = lissageDureeMatch ? parseInt(lissageDureeMatch[1]) : null;

  return {
    entreprise, adresse, commune, departement, annee,
    baseCommune, baseIntercommunalite: baseCommune,
    tauxCommune, tauxEPCI, tauxOM, tauxSyndicats, tauxGEMAPI,
    cotisationCommune2024, cotisationLisseeCommune2025,
    montantTotal, fraisGestion,
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
Contribuable : ${d.entreprise || "—"}

Madame, Monsieur,

Mandaté(e) par ${d.entreprise || "[NOM DU CONTRIBUABLE]"}, propriétaire du bien sis au ${d.adresse || "—"}, ${d.commune || "—"}, nous nous permettons de vous adresser la présente afin d'obtenir, dans un souci de transparence et conformément aux droits garantis par le code des relations entre le public et l'administration (CRPA, article L.312-1 et suivants), le détail complet du calcul ayant conduit à l'établissement de la taxe foncière sur les propriétés bâties pour l'année ${d.annee || 2025}.

L'avis d'imposition fait état des éléments suivants :
- Base d'imposition (commune) : ${d.baseCommune ? d.baseCommune + " €" : "—"}
- Montant total de l'impôt : ${d.montantTotal ? d.montantTotal + " €" : "—"}
${d.lissage ? `- Un lissage de +${d.lissageMontantAnnuel ?? "?"}€/an est mentionné depuis ${d.lissageDebut ?? "?"}${d.lissageDuree ? ` sur une période de ${d.lissageDuree} ans` : ""}.` : ""}

Après vérification, les points suivants appellent une clarification : ${anomalies}.

Dans ce cadre, nous vous demandons de bien vouloir nous communiquer :

1. La fiche d'évaluation détaillée du bien (6660-REV ou extrait GMBI), incluant :
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

// ---- UI helpers ----
function eur(n) {
  if (n == null || isNaN(n)) return "—";
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
}
function pct(n) {
  if (n == null || isNaN(n)) return "—";
  return (n * 100).toFixed(2).replace(".", ",") + "\u202f%";
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

// ---- Main component ----
export default function TFAudit() {
  const [phase, setPhase] = useState("upload");
  const [fileName, setFileName] = useState(null);
  const [fileData, setFileData] = useState(null);
  const [log, setLog] = useState([]);
  const [result, setResult] = useState(null);
  const [letter, setLetter] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

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

  async function run() {
    setPhase("running"); setLog([]); setResult(null); setLetter(null); setErrorMsg(null);
    try {
      let text = "";
      if (fileData?.isPdf) {
        addLog("Extraction du texte PDF…");
        text = await extractPdfText(fileData.base64);
        addLog(`${text.length} caractères extraits`);
      } else {
        addLog("Mode démonstration (SCI Place de la Croix)");
        // Inject real demo data directly
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
          lissage: true, lissageMontantAnnuel: 10, lissageDebut: 2017, lissageDuree: 10
        };
      } else {
        d = extractData(text);
      }

      addLog("Vérifications arithmétiques…");
      const baseC = d.baseCommune || 0;
      const baseI = d.baseIntercommunalite || baseC;
      const cotisC = d.tauxCommune ? Math.round(baseC * d.tauxCommune) : null;
      const cotisReste = Math.round(baseI * ((d.tauxEPCI||0)+(d.tauxOM||0)+(d.tauxSyndicats||0)+(d.tauxGEMAPI||0)));
      const totalRecalc = cotisC != null ? cotisC + cotisReste + (d.fraisGestion||0) : null;
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
        const flag = Math.abs(ecartMontant) > 5;
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

      checks.push({ id: "taux", status: "info",
        label: "Taux communal — vérification manuelle",
        detail: `${pct(d.tauxCommune)} affiché pour ${d.commune || "?"} en ${d.annee}. À comparer au taux officiel voté (disponible sur impots.gouv.fr ou auprès de la mairie).` });

      score = Math.min(100, score);
      setResult({ d, checks, score, totalRecalc, ecartMontant, evo, revaloOff });

      if (score > 0) {
        addLog("Génération du courrier…");
        const anomalies = checks.filter(c => c.status === "flag").map(c => c.label).join(", ");
        const ltr = generateLetter(d, anomalies);
        setLetter(ltr);
      }

      setPhase("done");
    } catch (e) {
      setErrorMsg(e?.message || String(e));
      setPhase("error");
    }
  }

  function reset() {
    setPhase("upload"); setFileName(null); setFileData(null);
    setLog([]); setResult(null); setLetter(null); setErrorMsg(null);
  }

  function downloadLetter() {
    const blob = new Blob([letter], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "demande-fiche-6660.txt"; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-5 py-4 flex items-center justify-between sticky top-0 z-10">
        <div>
          <div className="font-bold text-gray-900">Audit Taxe Foncière</div>
          <div className="text-xs text-gray-400">Explain Legal · TFPB v0.3</div>
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
              <Row label="Montant affiché" value={eur(result.d.montantTotal)} flag={result.ecartMontant != null && Math.abs(result.ecartMontant) > 5} />
              <Row label="Recalculé (base×taux)" value={eur(result.totalRecalc)} flag={result.ecartMontant != null && Math.abs(result.ecartMontant) > 5} />
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Points de contrôle</p>
              {result.checks.map(c => <Check key={c.id} {...c} />)}
            </div>

            {letter && (
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Courrier généré</p>
                  <button onClick={downloadLetter} className="flex items-center gap-1.5 text-xs border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50 text-gray-700">
                    <Download size={12} /> Télécharger
                  </button>
                </div>
                <pre className="text-xs font-mono text-gray-600 whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">{letter}</pre>
                <p className="text-xs text-gray-400 mt-3 leading-relaxed border-t border-gray-100 pt-3">Demande d'information uniquement — pas une contestation formelle. À valider avec votre expert-comptable avant envoi.</p>
              </div>
            )}

            {result.score === 0 && (
              <div className="bg-green-50 border border-green-200 rounded-xl p-4">
                <div className="flex items-center gap-2">
                  <CheckCircle2 size={16} className="text-green-600" />
                  <p className="text-sm font-medium text-green-700">Aucune anomalie détectée</p>
                </div>
                <p className="text-xs text-green-600 mt-1 leading-relaxed">Cela ne garantit pas que la valeur locative soit correcte — seule la fiche d'évaluation 6660 le confirme.</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
