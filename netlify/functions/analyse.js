const https = require('https');

const AIRTABLE_TOKEN = 'pataBCeGvhlN3N4Uq.cfa8a096a4b28fac19de4ea8006778cc5822fa610b9a2615cc144a4290e6a185';
const AIRTABLE_BASE  = 'appouax19tnHJj0TD';
const AIRTABLE_TABLE = 'tblGrm2yPn0ldTi01';
const F_REF    = 'fld02IfEMQb0zorrD';
const F_DESIGN = 'fldba0MGx8lL3TQWS';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function claudeCall(apiKey, messages, maxTokens) {
  const body = JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: maxTokens, messages });
  return httpRequest({
    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }
  }, body);
}

// Recherche Airtable via /search (full-text) puis /records pour les valeurs
async function findRef(nomProduit) {
  try {
    // Extraire mots clés en ignorant les mots génériques
    const stopwords = new Set(['maillot','casquette','sweat','short','pantalon','veste',
      'shirt','pack','coque','ensemble','survêtement','survetement','jogging','ballon',
      'chevaliere','chevalière','cagoule','coupe','vent','coupe-vent']);

    const mots = nomProduit.split(/[\s\-–—_\/]+/)
      .map(w => w.replace(/[^\w\u00C0-\u024F]/g, ''))
      .filter(w => w.length > 3 && !stopwords.has(w.toLowerCase()));

    // Si tous les mots sont des stopwords, prendre les plus longs quand même
    const keywords = mots.length > 0
      ? mots.sort((a, b) => b.length - a.length).slice(0, 2)
      : nomProduit.split(/[\s\-–]+/).filter(w => w.length > 2).slice(0, 2);

    const query = keywords.join(' ');
    if (!query.trim()) return null;

    // Étape 1 : search_records via REST
    const searchPath = `/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}/search`
      + `?query=${encodeURIComponent(query)}`
      + `&fields[]=${F_DESIGN}&fields[]=${F_REF}`;

    const searchRes = await httpRequest({
      hostname: 'api.airtable.com', path: searchPath, method: 'GET',
      headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
    });

    if (!searchRes.data.records || searchRes.data.records.length === 0) return null;

    // Étape 2 : list_records avec le recordId pour lire les champs
    const recordId = searchRes.data.records[0].id;
    const getPath = `/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`
      + `?records[]=${recordId}&fields[]=${F_DESIGN}&fields[]=${F_REF}`;

    const getRes = await httpRequest({
      hostname: 'api.airtable.com', path: getPath, method: 'GET',
      headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
    });

    if (!getRes.data.records || getRes.data.records.length === 0) return null;

    const fields = getRes.data.records[0].cellValuesByFieldId || {};
    return fields[F_REF] || null;
  } catch(e) {
    console.error('findRef error:', nomProduit, e.message);
    return null;
  }
}

function getText(data) {
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
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

  const photosCtx = photoNames.length > 0
    ? '\n\nProduits identifiés depuis les captures du site doretdeplatineshop.com :\n'
      + photoNames.map((n, i) => `- Photo ${i+1}: ${n}`).join('\n')
    : '';

  // ── ÉTAPE 1 : Claude analyse le message (sans MCP) ───────────────
  const p1 = `Tu es un assistant pour D'or et de Platine. Analyse ce message WhatsApp et extrais TOUS les produits ET les infos de livraison.${photosCtx}

RÈGLES ADRESSE: CP seul → déduis ville (13012=Marseille 12e, 75001=Paris 1er, 69001=Lyon 1er, 33000=Bordeaux, 06000=Nice, 31000=Toulouse, 59000=Lille, 44000=Nantes, 13100=Aix-en-Provence, 76000=Rouen, 67000=Strasbourg).
RÈGLES ALERTES: adresse incomplète, quantité manquante, taille manquante (textile uniquement).

Retourne UNIQUEMENT ce JSON sans markdown:
{"products":[{"nom_original":"texte exact du message","nom_propre":"nom tel qu'affiché sur doretdeplatineshop.com","quantite":1,"taille":"taille ou N/A","source":"texte ou photo"}],"destinataire":{"nom":"","adresse":"adresse complète avec ville déduite","telephone":""},"alertes":[{"type":"warning","message":""}]}

Message: ${message}`;

  let result;
  try {
    const r = await claudeCall(apiKey, [{ role: 'user', content: p1 }], 1200);
    if (r.status !== 200) throw new Error(r.data.error?.message || 'Erreur Claude ' + r.status);
    const text = getText(r.data);
    const clean = text.replace(/```json\s*/g,'').replace(/```\s*/g,'').trim();
    const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
    result = JSON.parse(clean.substring(s, e+1));
  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }

  // ── ÉTAPE 2 : Chercher les refs via Airtable REST (search + get) ──
  if (result.products) {
    for (const p of result.products) {
      const nom = (p.nom_propre || p.nom_original || '').trim();
      p.reference_believe = 'N/A';
      p.statut = 'introuvable';
      if (!nom) continue;
      const ref = await findRef(nom);
      if (ref) { p.reference_believe = ref; p.statut = 'trouve'; }
    }
  }

  // ── ÉTAPE 3 : Message WhatsApp ────────────────────────────────────
  const d = result.destinataire || {};
  const lines = (result.products || []).map(p =>
    `${p.nom_propre||p.nom_original} | Réf: ${p.reference_believe||'N/A'} | Qté: ${p.quantite||'?'} | Taille: ${p.taille||'?'}`
  ).join('\n');
  const alts = (result.alertes || []).map(a => a.message).join('\n');

  try {
    const r = await claudeCall(apiKey, [{ role: 'user', content:
      `Génère un message WhatsApp de confirmation D'or et de Platine. Tutoiement, *gras*, emojis, ━━━.\nProduits:\n${lines}\nLivraison: ${d.nom||'?'}, ${d.adresse||'?'}, ${d.telephone||'?'}\n${alts?'⚠️ Manquant:\n'+alts:''}\nRetourne UNIQUEMENT le message.`
    }], 500);
    if (r.status === 200) result.message_whatsapp = getText(r.data);
  } catch(e) {}

  return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
};
