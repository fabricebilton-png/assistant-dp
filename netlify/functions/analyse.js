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

function claudeCall(apiKey, body) {
  const s = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(s),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(s);
    req.end();
  });
}

function airtableGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.airtable.com', path, method: 'GET',
      headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Recherche via l'endpoint /search d'Airtable (full-text, fuzzy, comme search_records)
// puis récupère les valeurs via /records?records[]=
async function findRef(designation) {
  try {
    // Extraire les mots significatifs (>3 lettres), ignorer les mots génériques
    const stopwords = ['maillot','casquette','sweat','short','pantalon','veste','tshirt','shirt','pack','coque'];
    const words = designation.split(/[\s\-–—_]+/)
      .filter(w => w.length > 3)
      .filter(w => !stopwords.includes(w.toLowerCase()));

    // Si tous les mots sont des stopwords, prendre quand même les 2 premiers
    const keywords = words.length > 0 ? words : designation.split(/[\s\-–—_]+/).filter(w => w.length > 2);

    // Chercher avec les mots les plus discriminants (les plus longs)
    const searchQuery = keywords.sort((a,b) => b.length - a.length).slice(0, 2).join(' ');
    if (!searchQuery) return null;

    // Étape 1 : search (full-text fuzzy)
    const searchPath = `/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}/search`
      + `?query=${encodeURIComponent(searchQuery)}`
      + `&fields[]=${F_DESIGN}&fields[]=${F_REF}`;

    const searchRes = await airtableGet(searchPath);
    if (!searchRes.records || searchRes.records.length === 0) return null;

    // Étape 2 : récupérer les valeurs du premier record
    const recordId = searchRes.records[0].id;
    const getPath = `/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`
      + `?records[]=${recordId}&fields[]=${F_DESIGN}&fields[]=${F_REF}`;

    const getRes = await airtableGet(getPath);
    if (!getRes.records || getRes.records.length === 0) return null;

    const fields = getRes.records[0].cellValuesByFieldId || {};
    return fields[F_REF] || null;
  } catch(e) {
    console.error('findRef error:', e.message);
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

  const photosCtx = photoNames.length > 0
    ? '\n\nProduits identifiés depuis les captures d\'écran du site doretdeplatineshop.com :\n'
      + photoNames.map((n, i) => `- Photo ${i+1}: ${n}`).join('\n')
      + '\nCes produits sont à inclure dans la commande avec source "photo".'
    : '';

  // ── Étape 1 : Claude analyse le message + photos ─────────────────
  const step1 = `Tu es un assistant pour D'or et de Platine. Analyse ce message WhatsApp et identifie TOUS les produits commandés (texte ET photos).${photosCtx}

Règles adresse: CP seul→déduis ville (13012=Marseille 12e,75001=Paris 1er,69001=Lyon 1er,33000=Bordeaux,06000=Nice,31000=Toulouse,59000=Lille,44000=Nantes,76000=Rouen,67000=Strasbourg,13100=Aix-en-Provence).
Alertes: adresse incomplète (rue/CP/ville/téléphone manquant), quantité manquante, taille manquante (textile).

JSON UNIQUEMENT sans markdown:
{"products":[{"nom_original":"texte brut ou nom photo","nom_propre":"nom tel qu'affiché sur le site doretdeplatineshop.com","quantite":1,"taille":"taille ou N/A","source":"texte ou photo"}],"destinataire":{"nom":"","adresse":"","telephone":""},"alertes":[{"type":"warning","message":""}]}

Message: ${message}`;

  let result;
  try {
    const r = await claudeCall(apiKey, {
      model: 'claude-sonnet-4-5',
      max_tokens: 1200,
      messages: [{ role: 'user', content: step1 }]
    });
    if (r.status !== 200) throw new Error(r.data.error?.message || 'Erreur Claude ' + r.status);
    const text = (r.data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    result = parseJSON(text);
  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }

  // ── Étape 2 : Recherche refs via Airtable full-text search ───────
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

  // ── Étape 3 : Message WhatsApp ───────────────────────────────────
  const d = result.destinataire || {};
  const prodLines = (result.products || []).map(p =>
    `- ${p.nom_propre||p.nom_original} | Réf: ${p.reference_believe} | Qté: ${p.quantite||'?'} | Taille: ${p.taille||'?'}`
  ).join('\n');
  const alertes = (result.alertes || []).map(a => `⚠️ ${a.message}`).join('\n');

  try {
    const r = await claudeCall(apiKey, {
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      messages: [{ role: 'user', content: `Génère un message WhatsApp de confirmation commande D'or et de Platine. Tutoiement, *gras*, emojis, séparateurs ━━━.
Produits:\n${prodLines}
Livraison: ${d.nom||'?'}, ${d.adresse||'?'}, ${d.telephone||'?'}
${alertes ? 'Infos manquantes:\n' + alertes : ''}
Retourne UNIQUEMENT le message WhatsApp.` }]
    });
    if (r.status === 200) {
      result.message_whatsapp = (r.data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').trim();
    }
  } catch(e) {}

  return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
};

function parseJSON(text) {
  const clean = text.replace(/```json\s*/g,'').replace(/```\s*/g,'').trim();
  const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
  if (s<0||e<0) throw new Error('Aucun JSON');
  let str = clean.substring(s,e+1);
  try { return JSON.parse(str); } catch(_) {
    str = str.replace(/,\s*$/,'');
    let ob=0,ob2=0,ins=false,esc=false;
    for(const c of str){if(esc){esc=false;continue;}if(c==='\\'&&ins){esc=true;continue;}if(c==='"'){ins=!ins;continue;}if(!ins){if(c==='{')ob++;else if(c==='}')ob--;if(c==='[')ob2++;else if(c===']')ob2--;}}
    while(ob2>0){str+=']';ob2--;}while(ob>0){str+='}';ob--;}
    return JSON.parse(str);
  }
}
