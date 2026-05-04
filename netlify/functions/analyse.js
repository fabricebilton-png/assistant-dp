const https = require('https');

const AIRTABLE_TOKEN = 'pataBCeGvhlN3N4Uq.cfa8a096a4b28fac19de4ea8006778cc5822fa610b9a2615cc144a4290e6a185';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

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

function httpsGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.airtable.com', path, method: 'GET',
      headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Étape 1 : Claude analyse le message → liste de produits sans refs
async function analyseMessage(apiKey, message, photoNames) {
  const photosCtx = photoNames.length > 0
    ? '\nPhotos: ' + photoNames.join(', ')
    : '';

  const prompt = `Assistant D'or et de Platine. Analyse ce message WhatsApp.${photosCtx}

Règles adresse: CP seul → déduis ville (13012=Marseille 12e, 75001=Paris 1er). Ville seule → note CP manquant.
Alertes: adresse incomplète, quantité manquante, taille manquante (textile).

JSON brut uniquement:
{"products":[{"nom_original":"","nom_propre":"","reference_believe":"N/A","quantite":1,"taille":"","statut":"trouve","source":"texte"}],"destinataire":{"nom":"","adresse":"","telephone":""},"alertes":[{"type":"warning","message":""}],"message_whatsapp":"Message tutoiement, *gras*, emojis, refs Believe, adresse, demande confirmation, alertes."}

Message: ${message}`;

  const body = JSON.stringify({
    model: 'claude-sonnet-4-5',
    max_tokens: 2000,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  });

  const res = await httpsPost('api.anthropic.com', '/v1/messages', {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  }, body);

  const data = JSON.parse(res.body);
  if (res.status !== 200) throw new Error(data.error?.message || 'Erreur Claude ' + res.status);

  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return parseJSON(text);
}

// Étape 2 : Recherche ref Believe via Airtable REST pour chaque produit
async function findRef(nomProduit) {
  const q = nomProduit.split(/\s+/).filter(w => w.length > 2).slice(0, 2).join(' ');
  if (!q) return null;

  const formula = `SEARCH("${q.toLowerCase().replace(/"/g, '')}",LOWER({Designation}))`;
  const path = `/v0/appouax19tnHJj0TD/tblGrm2yPn0ldTi01`
    + `?filterByFormula=${encodeURIComponent(formula)}`
    + `&fields[]=Designation&fields[]=R%C3%A9f%20Believe&maxRecords=1`;

  try {
    const res = await httpsGet(path);
    const data = JSON.parse(res.body);
    if (!data.records || data.records.length === 0) return null;
    const fields = data.records[0].fields || {};
    return fields['Réf Believe'] || null;
  } catch(e) {
    return null;
  }
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: '{}' };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(e) {}

  const apiKey = (body.apiKey || '').trim();
  if (!apiKey.startsWith('sk-ant-')) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Clé API invalide' }) };
  }

  const { message, photoNames = [] } = body;
  if (!message) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Message manquant' }) };

  try {
    // Étape 1 : Claude analyse le message (prompt court)
    const result = await analyseMessage(apiKey, message, photoNames);

    // Étape 2 : Enrichir les refs via Airtable REST (sans passer par Claude)
    if (result.products) {
      for (const p of result.products) {
        const nom = (p.nom_propre || p.nom_original || '').trim();
        if (!nom) continue;
        const ref = await findRef(nom);
        if (ref) {
          p.reference_believe = ref;
          p.statut = 'trouve';
        }
      }
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};

function parseJSON(text) {
  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('Aucun JSON');
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
    while (ob > 0) { str += '}'; ob--; }
    return JSON.parse(str);
  }
}
