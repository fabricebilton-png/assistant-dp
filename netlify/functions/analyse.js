const https = require('https');

const AIRTABLE_TOKEN = 'pataBCeGvhlN3N4Uq.cfa8a096a4b28fac19de4ea8006778cc5822fa610b9a2615cc144a4290e6a185';
const AIRTABLE_BASE  = 'appouax19tnHJj0TD';
const AIRTABLE_TABLE = 'tblGrm2yPn0ldTi01';
const F_REF     = 'fld02IfEMQb0zorrD';
const F_DESIGN  = 'fldba0MGx8lL3TQWS';
const F_CAT     = 'fldayu3Yn6iraIcns';

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

// Recherche Airtable par mots-clés + catégorie optionnelle
async function findRef(designation, categorie) {
  try {
    const mots = designation.split(/[\s\-–]+/).filter(w => w.length > 3).slice(0, 3);
    if (mots.length === 0) return null;

    const searchConds = mots.map(m =>
      `SEARCH("${m.toLowerCase().replace(/"/g, '')}", LOWER({${F_DESIGN}}))`
    );
    let formula = mots.length > 1 ? `OR(${searchConds.join(', ')})` : searchConds[0];

    // Ajouter filtre catégorie si dispo
    if (categorie) {
      formula = `AND({${F_CAT}}="${categorie}", ${formula})`;
    }

    const qs = new URLSearchParams({ filterByFormula: formula, maxRecords: '5' });
    qs.append('fields[]', F_DESIGN);
    qs.append('fields[]', F_REF);
    qs.append('fields[]', F_CAT);

    const res = await airtableGet(`/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?${qs.toString()}`);

    if (!res.records || res.records.length === 0) {
      // Fallback sans catégorie
      if (categorie) return findRef(designation, null);
      return null;
    }

    // Meilleur match : produit avec le plus de mots en commun
    const desigLower = designation.toLowerCase();
    let best = res.records[0], bestScore = 0;
    for (const r of res.records) {
      const nom = (r.fields[F_DESIGN] || '').toLowerCase();
      const score = mots.filter(m => nom.includes(m.toLowerCase())).length;
      if (score > bestScore) { best = r; bestScore = score; }
    }

    return best.fields[F_REF] || null;
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

  // Construire le contexte photos pour le prompt
  const photosCtx = photoNames.length > 0
    ? '\n\nProduits identifiés depuis les captures d\'écran du site doretdeplatineshop.com :\n'
      + photoNames.map((n, i) => `- Photo ${i+1}: ${n}`).join('\n')
      + '\nCes produits sont à inclure dans la commande.'
    : '';

  // ── Étape 1 : Claude analyse message + produits photos ───────────
  const step1 = `Tu es un assistant pour D'or et de Platine. Analyse ce message WhatsApp et identifie tous les produits commandés.
Les produits peuvent venir du texte du message ET des captures d'écran jointes.${photosCtx}

Règles adresse: CP seul→déduis ville (13012=Marseille 12e, 75001=Paris 1er, 69001=Lyon 1er, 33000=Bordeaux, 06000=Nice, 31000=Toulouse, 59000=Lille, 44000=Nantes, 76000=Rouen, 67000=Strasbourg).
Règles alertes: adresse incomplète (manque rue/CP/ville/téléphone), quantité manquante, taille manquante (textile).

Pour chaque produit, extrais la catégorie parmi: T-shirt, Casquette, Sweat, Survêtement, Short, Pantalon, Veste, Claquette, Accessoire, Vinyle, CD, USB, Pack, Ballon, Chevalière, Coque téléphone, Maillot, Cagoule.

JSON UNIQUEMENT sans markdown:
{"products":[{"nom_original":"texte brut ou nom photo","nom_propre":"nom exact tel qu'affiché sur le site","categorie":"catégorie ou null","quantite":1,"taille":"taille ou N/A","source":"texte ou photo"}],"destinataire":{"nom":"","adresse":"","telephone":""},"alertes":[{"type":"warning","message":""}]}

Message WhatsApp: ${message}`;

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

  // ── Étape 2 : Enrichir refs Believe via Airtable REST ────────────
  if (result.products) {
    for (const p of result.products) {
      const nom = (p.nom_propre || p.nom_original || '').trim();
      p.reference_believe = 'N/A';
      p.statut = 'introuvable';
      if (!nom) continue;
      const ref = await findRef(nom, p.categorie || null);
      if (ref) { p.reference_believe = ref; p.statut = 'trouve'; }
    }
  }

  // ── Étape 3 : Message WhatsApp formaté ───────────────────────────
  const d = result.destinataire || {};
  const prodLines = (result.products || []).map(p =>
    `- ${p.nom_propre||p.nom_original} | Réf: ${p.reference_believe} | Qté: ${p.quantite||'?'} | Taille: ${p.taille||'?'}`
  ).join('\n');
  const alertes = (result.alertes || []).map(a => `⚠️ ${a.message}`).join('\n');

  try {
    const r = await claudeCall(apiKey, {
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      messages: [{ role: 'user', content: `Génère un message WhatsApp de confirmation commande D'or et de Platine. Tutoiement, *gras*, emojis, ━━━.
Produits:\n${prodLines}
Livraison: ${d.nom||'?'}, ${d.adresse||'?'}, ${d.telephone||'?'}
${alertes ? 'Infos manquantes à signaler:\n' + alertes : ''}
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
