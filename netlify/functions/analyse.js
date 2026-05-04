const https = require('https');

const AIRTABLE_TOKEN = 'pataBCeGvhlN3N4Uq.cfa8a096a4b28fac19de4ea8006778cc5822fa610b9a2615cc144a4290e6a185';
const AIRTABLE_BASE  = 'appouax19tnHJj0TD';
const AIRTABLE_TABLE = 'tblGrm2yPn0ldTi01';

// Champs Airtable
const FIELD_DESIGNATION = 'fldba0MGx8lL3TQWS';
const FIELD_REF         = 'fld02IfEMQb0zorrD';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

// ── Helpers réseau ────────────────────────────────────────────────────────────

function get(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

function post(hostname, path, headers, body) {
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

// ── Recherche Airtable ────────────────────────────────────────────────────────

async function searchAirtable(query) {
  const q = query.replace(/["']/g, '').substring(0, 60).toLowerCase();
  const formula = `OR(SEARCH("${q}",LOWER({${FIELD_DESIGNATION}})),SEARCH("${q}",LOWER({${FIELD_REF}})))`;
  const path = `/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`
    + `?filterByFormula=${encodeURIComponent(formula)}`
    + `&fields[]=${FIELD_DESIGNATION}&fields[]=${FIELD_REF}&maxRecords=3`;

  const res = await get('api.airtable.com', path, {
    'Authorization': `Bearer ${AIRTABLE_TOKEN}`
  });

  const data = JSON.parse(res.body);
  if (!data.records || data.records.length === 0) return null;

  const fields = data.records[0].fields || {};
  return {
    nom: fields[FIELD_DESIGNATION] || null,
    ref: fields[FIELD_REF] || null
  };
}

// ── Handler principal ─────────────────────────────────────────────────────────

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: '{}' };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(e) {}

  const apiKey = (body.apiKey || '').trim();
  if (!apiKey.startsWith('sk-ant-')) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Clé API invalide' }) };
  }

  const { message, photoNames = [] } = body;
  if (!message) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Message manquant' }) };

  // ── 1. Claude analyse le message et identifie les produits ────────────────
  const photosCtx = photoNames.length > 0
    ? '\n\nProduits identifiés depuis les captures du site doretdeplatineshop.com :\n'
      + photoNames.map((n, i) => `- Photo ${i+1}: ${n}`).join('\n')
    : '';

  const promptAnalyse = `Tu es un assistant pour D'or et de Platine (doretdeplatineshop.com), boutique de JuL gérée par Believe.
Analyse ce message WhatsApp et retourne UNIQUEMENT un JSON brut sans markdown ni texte autour.${photosCtx}

ADRESSE : Si code postal seul → déduis la ville (ex: 13012→Marseille 12e, 75001→Paris 1er, 69001→Lyon 1er). Si ville seule → note que le CP manque. Vérifie cohérence CP/ville.

ALERTES à signaler dans "alertes" ET dans le message WhatsApp :
- Adresse incomplète (manque rue, CP, ville ou téléphone)
- Quantité manquante pour un article
- Taille manquante pour un article textile

JSON attendu (reference_believe doit rester "N/A" — sera rempli ensuite) :
{
  "products": [
    {"nom_original":"texte brut","nom_propre":"nom officiel du produit","reference_believe":"N/A","quantite":1,"taille":"M ou N/A","statut":"trouve","source":"texte"}
  ],
  "destinataire": {"nom":"...","adresse":"adresse complète avec ville déduite","telephone":"..."},
  "alertes": [{"type":"warning","message":"..."}],
  "message_whatsapp": "Message WhatsApp complet avec *gras*, emojis, séparateurs ━━━, récapitulatif produits avec refs Believe (à remplir), adresse, et demande de confirmation. Signale clairement les infos manquantes."
}

Message à analyser :
${message}`;

  let claudeResult;
  try {
    const claudeBody = JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      messages: [{ role: 'user', content: [{ type: 'text', text: promptAnalyse }] }]
    });

    const res = await post('api.anthropic.com', '/v1/messages', {
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

  // ── 2. Enrichir les refs Believe via Airtable ─────────────────────────────
  if (claudeResult.products) {
    for (const p of claudeResult.products) {
      const nom = (p.nom_propre || p.nom_original || '').trim();
      if (!nom) continue;

      // Chercher avec les 3 premiers mots significatifs
      const words = nom.split(/\s+/).filter(w => w.length > 2).slice(0, 3).join(' ');
      try {
        const found = await searchAirtable(words);
        if (found && found.ref) {
          p.reference_believe = found.ref;
          if (found.nom) p.nom_propre = found.nom;
          p.statut = 'trouve';
        }
      } catch(e) {
        console.error('Airtable error for', nom, e.message);
      }
    }
  }

  // ── 3. Mettre à jour le message WhatsApp avec les vraies refs ─────────────
  if (claudeResult.message_whatsapp && claudeResult.products) {
    // Remplacer "N/A" dans le message par les vraies refs trouvées
    for (const p of claudeResult.products) {
      if (p.reference_believe && p.reference_believe !== 'N/A') {
        claudeResult.message_whatsapp = claudeResult.message_whatsapp
          .replace(new RegExp(escapeRegex(p.nom_propre || p.nom_original) + '[^\\n]*N/A', 'g'),
            match => match.replace('N/A', p.reference_believe));
      }
    }
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify(claudeResult)
  };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseJSON(text) {
  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('Aucun JSON dans la réponse');
  let str = clean.substring(s, e + 1);
  try { return JSON.parse(str); } catch(_) {
    // Réparer JSON tronqué
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

function escapeRegex(s) {
  return (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
