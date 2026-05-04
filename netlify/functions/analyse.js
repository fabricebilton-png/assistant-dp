const https = require('https');

const AIRTABLE_TOKEN = 'pataBCeGvhlN3N4Uq.cfa8a096a4b28fac19de4ea8006778cc5822fa610b9a2615cc144a4290e6a185';
const AIRTABLE_BASE  = 'appouax19tnHJj0TD';
const AIRTABLE_TABLE = 'tblGrm2yPn0ldTi01';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function httpsGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.airtable.com',
      path,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'POST', headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Recherche Airtable — utilise les noms de champs dans fields[] et lit cellValuesByFieldId
async function searchAirtable(query) {
  const q = query.replace(/["'\\]/g, '').substring(0, 60).toLowerCase();
  if (!q) return null;

  // Recherche via filterByFormula avec les noms de champs
  const formula = `OR(SEARCH("${q}",LOWER({Designation})),SEARCH("${q}",LOWER({R\u00e9f Believe})))`;
  const qs = new URLSearchParams({
    filterByFormula: formula,
    maxRecords: '3',
    returnFieldsByFieldId: 'true'  // Force le retour par field ID
  });

  const path = `/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?${qs.toString()}`;

  try {
    const res = await httpsGet(path, AIRTABLE_TOKEN);
    const data = JSON.parse(res.body);

    if (!data.records || data.records.length === 0) return null;

    // Avec returnFieldsByFieldId=true, les champs sont dans cellValuesByFieldId
    const fields = data.records[0].cellValuesByFieldId || data.records[0].fields || {};

    return {
      nom: fields['fldba0MGx8lL3TQWS'] || fields['Designation'] || null,
      ref: fields['fld02IfEMQb0zorrD'] || fields['R\u00e9f Believe'] || null
    };
  } catch(e) {
    console.error('Airtable error:', e.message);
    return null;
  }
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: '{}' };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(e) {}

  const apiKey = (body.apiKey || '').trim();
  if (!apiKey.startsWith('sk-ant-')) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Cl\u00e9 API invalide' }) };
  }

  const { message, photoNames = [] } = body;
  if (!message) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Message manquant' }) };

  // ── 1. Claude analyse le message ─────────────────────────────────
  const photosCtx = photoNames.length > 0
    ? '\n\nProduits identifi\u00e9s depuis les captures du site doretdeplatineshop.com :\n'
      + photoNames.map((n, i) => `- Photo ${i+1}: ${n}`).join('\n')
    : '';

  const promptAnalyse = `Tu es un assistant pour D'or et de Platine (doretdeplatineshop.com), boutique de JuL g\u00e9r\u00e9e par Believe.
Analyse ce message WhatsApp et retourne UNIQUEMENT un JSON brut sans markdown ni texte autour.${photosCtx}

ADRESSE : Si code postal seul \u2192 d\u00e9duis la ville (ex: 13012\u2192Marseille 12e, 75001\u2192Paris 1er, 69001\u2192Lyon 1er). Si ville seule \u2192 note que le CP manque.

ALERTES \u00e0 signaler :
- Adresse incompl\u00e8te (manque rue, CP, ville ou t\u00e9l\u00e9phone)
- Quantit\u00e9 manquante pour un article
- Taille manquante pour un article textile

JSON attendu :
{
  "products": [
    {"nom_original":"texte brut","nom_propre":"nom officiel du produit","reference_believe":"N/A","quantite":1,"taille":"M ou N/A","statut":"trouve","source":"texte"}
  ],
  "destinataire": {"nom":"...","adresse":"adresse compl\u00e8te avec ville d\u00e9duite","telephone":"..."},
  "alertes": [{"type":"warning","message":"..."}],
  "message_whatsapp": "Message WhatsApp complet avec *gras*, emojis, s\u00e9parateurs \u2501\u2501\u2501, r\u00e9capitulatif produits avec refs Believe, adresse, et demande de confirmation."
}

Message \u00e0 analyser :
${message}`;

  let claudeResult;
  try {
    const claudeBody = JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      messages: [{ role: 'user', content: [{ type: 'text', text: promptAnalyse }] }]
    });

    const res = await httpsPost('api.anthropic.com', '/v1/messages', {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(claudeBody),
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }, claudeBody);

    const data = JSON.parse(res.body);
    if (res.status !== 200) {
      return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: data.error?.message || 'Erreur Claude' }) };
    }

    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    claudeResult = parseJSON(text);
  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Erreur analyse: ' + e.message }) };
  }

  // ── 2. Enrichir les refs Believe via Airtable ─────────────────────
  if (claudeResult.products) {
    for (const p of claudeResult.products) {
      const nom = (p.nom_propre || p.nom_original || '').trim();
      if (!nom) continue;

      // Chercher avec les mots significatifs
      const words = nom.split(/\s+/).filter(w => w.length > 2).slice(0, 3).join(' ');
      const found = await searchAirtable(words);
      if (found && found.ref) {
        p.reference_believe = found.ref;
        if (found.nom) p.nom_propre = found.nom;
        p.statut = 'trouve';
      }
    }
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify(claudeResult)
  };
};

function parseJSON(text) {
  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('Aucun JSON dans la r\u00e9ponse');
  let str = clean.substring(s, e + 1);
  try { return JSON.parse(str); } catch(_) {
    str = str.replace(/,\s*$/, '');
    let ob = 0, ob2 = 0, ins = false, esc = false;
    for (const c of str) {
      if (esc) { esc = false; continue; }
      if (c === '\\' && ins) { esc = true; continue; }
      if (c === '"') { ins = !ins; continue; }
      if (!ins) {
        if (c === '{') ob++; else if (c === '}') ob--;
        if (c === '[') ob2++; else if (c === ']') ob2--;
      }
    }
    while (ob2 > 0) { str += ']'; ob2--; }
    while (ob > 0)  { str += '}'; ob--; }
    return JSON.parse(str);
  }
}
