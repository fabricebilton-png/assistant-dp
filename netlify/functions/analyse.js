const https = require('https');

// ── Config Airtable ───────────────────────────────────────────────────────────
const AIRTABLE_TOKEN  = 'pataBCeGvhlN3N4Uq.cfa8a096a4b28fac19de4ea8006778cc5822fa610b9a2615cc144a4290e6a185';
const AIRTABLE_BASE   = 'appouax19tnHJj0TD';
const AIRTABLE_TABLE  = 'tblGrm2yPn0ldTi01';
const F_REF     = 'fld02IfEMQb0zorrD';  // Réf Believe
const F_DESIGN  = 'fldba0MGx8lL3TQWS';  // Designation
const F_CAT     = 'fldayu3Yn6iraIcns';  // Catégorie
const F_ARTISTE = 'fldMRtaVIkYtBmEYM';  // Artiste/Marque (lien)
const F_CREATED = 'fldq1uaM2giuThUtK';  // Date de création
const JUL_ARTISTE_ID = 'recTpV0GW1YBPlT5d'; // ID de JuL dans la table ARTISTE

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function claudeCall(apiKey, messages, maxTokens) {
  const body = JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: maxTokens, messages });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
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
    req.write(body);
    req.end();
  });
}

function getText(data) {
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

// ── Recherche ref Airtable (filtrée sur produits JuL uniquement) ──────────────
async function findRef(nomProduit) {
  try {
    // Stopwords à ignorer pour la recherche
    const stopwords = new Set(['maillot','casquette','sweat','short','pantalon','veste',
      'shirt','pack','coque','ensemble','survêtement','survetement','jogging',
      'chevaliere','chevalière','cagoule','coupe','imperméable','impermeable',
      'ballon','vinyle','album','tshirt','accessoire','totebag','sac','bob',
      'claquette','chaussette','boxer','briquet','porte','cles','clef']);

    const mots = nomProduit.split(/[\s\-–—_\/\+]+/)
      .map(w => w.trim())
      .filter(w => w.length > 3 && !stopwords.has(w.toLowerCase()));

    const keywords = mots.length > 0
      ? mots.sort((a, b) => b.length - a.length).slice(0, 2)
      : nomProduit.split(/[\s\-–]+/).filter(w => w.length > 2).slice(0, 2);

    if (keywords.length === 0) return null;

    // Formula : filtre sur produits JuL ET mots-clés dans Designation
    const searchConds = keywords.map(k =>
      `SEARCH("${k.toLowerCase().replace(/['"]/g, '')}", LOWER({${F_DESIGN}}))`
    );
    const keywordFilter = searchConds.length > 1 ? `AND(${searchConds.join(',')})` : searchConds[0];

    // Filtre JuL : via le champ Artiste/Marque (multipleRecordLinks)
    // On utilise FIND() pour vérifier la présence de l'ID JuL dans les liens
    const julFilter = `FIND("${JUL_ARTISTE_ID}", ARRAYJOIN({${F_ARTISTE}}, ",")) > 0`;

    const formula = `AND(${julFilter}, ${keywordFilter})`;

    const qs = new URLSearchParams({ filterByFormula: formula, maxRecords: '5' });
    qs.append('fields[]', F_DESIGN);
    qs.append('fields[]', F_REF);
    qs.append('fields[]', F_CAT);

    const res = await airtableGet(`/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?${qs.toString()}`);

    if (res.records && res.records.length > 0) {
      // Meilleur match
      let best = res.records[0];
      let bestScore = 0;
      for (const r of res.records) {
        const nom = (r.fields[F_DESIGN] || '').toLowerCase();
        const score = keywords.filter(k => nom.includes(k.toLowerCase())).length;
        if (score > bestScore) { best = r; bestScore = score; }
      }
      const ref = best.fields[F_REF] || best.fields['Réf Believe'];
      if (ref) return { ref, nom: best.fields[F_DESIGN] || best.fields['Designation'], fallback: false };
    }

    // Fallback : OR sur un seul mot clé
    if (keywords.length > 1) {
      const formula2 = `AND(${julFilter}, ${searchConds[0]})`;
      const qs2 = new URLSearchParams({ filterByFormula: formula2, maxRecords: '3' });
      qs2.append('fields[]', F_DESIGN);
      qs2.append('fields[]', F_REF);
      const res2 = await airtableGet(`/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?${qs2.toString()}`);
      if (res2.records && res2.records.length > 0) {
        const ref = res2.records[0].fields[F_REF] || res2.records[0].fields['Réf Believe'];
        if (ref) return { ref, nom: res2.records[0].fields[F_DESIGN], fallback: false };
      }
    }

    return null;
  } catch(e) {
    console.error('findRef error:', nomProduit, e.message);
    return null;
  }
}

// ── Fallback : derniers produits JuL créés par catégorie ─────────────────────
async function findLatestByCategory(typeProduit) {
  try {
    const catMap = {
      'casquette': 'CASQUETTE', 'cap': 'CASQUETTE', 'bob': 'CASQUETTE',
      'tshirt': 'TEXTILE', 'shirt': 'TEXTILE', 'maillot': 'TEXTILE',
      'sweat': 'TEXTILE', 'hoodie': 'TEXTILE', 'survêtement': 'TEXTILE',
      'survetement': 'TEXTILE', 'short': 'TEXTILE', 'pantalon': 'TEXTILE',
      'veste': 'TEXTILE', 'jogging': 'TEXTILE', 'boxer': 'TEXTILE',
      'claquette': 'CHAUSSURES',
      'accessoire': 'ACCESSOIRE', 'chevalière': 'ACCESSOIRE', 'chevaliere': 'ACCESSOIRE',
      'disque': 'DISQUE', 'vinyle': 'DISQUE', 'cd': 'DISQUE',
      'coque': 'ACCESSOIRE', 'briquet': 'ACCESSOIRE',
    };

    const key = Object.keys(catMap).find(k => (typeProduit || '').toLowerCase().includes(k));
    if (!key) return null;
    const airtableCat = catMap[key];

    const julFilter = `FIND("${JUL_ARTISTE_ID}", ARRAYJOIN({${F_ARTISTE}}, ",")) > 0`;
    const catFilter = `{${F_CAT}}="${airtableCat}"`;
    const formula = `AND(${julFilter}, ${catFilter})`;

    const qs = new URLSearchParams({ filterByFormula: formula, maxRecords: '1' });
    qs.append('fields[]', F_DESIGN);
    qs.append('fields[]', F_REF);
    qs.append('fields[]', F_CAT);
    qs.append('sort[0][field]', F_CREATED);
    qs.append('sort[0][direction]', 'desc');

    const res = await airtableGet(`/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?${qs.toString()}`);
    if (!res.records || res.records.length === 0) return null;

    const f = res.records[0].fields;
    const ref = f[F_REF] || f['Réf Believe'];
    const nom = f[F_DESIGN] || f['Designation'];
    return ref ? { ref, nom, fallback: true } : null;
  } catch(e) {
    return null;
  }
}

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

// ── Handler principal ─────────────────────────────────────────────────────────
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
    ? '\n\nProduits identifiés depuis les captures du site doretdeplatineshop.com (boutique officielle JuL) :\n'
      + photoNames.map((n, i) => `- Photo ${i+1}: ${n}`).join('\n')
    : '';

  // ── ÉTAPE 1 : Analyse message + photos ───────────────────────────
  const p1 = `Tu es l'assistant de la boutique D'or et de Platine, boutique officielle de JuL (doretdeplatineshop.com).
Analyse ce message WhatsApp et identifie TOUS les produits commandés en combinant :
1. Le texte du message WhatsApp
2. Les noms des produits identifiés dans les photos${photosCtx}
3. Ta connaissance du catalogue JuL sur doretdeplatineshop.com

Règles adresse : CP seul → déduis la ville (13012=Marseille 12e, 75001=Paris 1er, 69001=Lyon 1er, 33000=Bordeaux, 06000=Nice, 31000=Toulouse, 59000=Lille, 44000=Nantes, 76000=Rouen, 67000=Strasbourg, 13100=Aix-en-Provence).
Alertes : adresse incomplète (rue/CP/ville/téléphone manquant), quantité manquante, taille manquante (textile uniquement).

Pour chaque produit, extrais le type générique (casquette/tshirt/sweat/survêtement/short/pantalon/veste/claquette/accessoire/disque/vinyle/coque/chevalière).

JSON UNIQUEMENT sans markdown :
{"products":[{"nom_original":"texte brut ou nom photo","nom_propre":"nom exact tel qu'affiché sur doretdeplatineshop.com","type_produit":"type générique","quantite":1,"taille":"taille ou N/A","source":"texte ou photo"}],"destinataire":{"nom":"","adresse":"adresse complète avec ville déduite","telephone":""},"alertes":[{"type":"warning","message":""}]}

Message WhatsApp : ${message}`;

  let result;
  try {
    const r = await claudeCall(apiKey, [{ role: 'user', content: p1 }], 1200);
    if (r.status !== 200) throw new Error(r.data.error?.message || 'Erreur step1 ' + r.status);
    result = parseJSON(getText(r.data));
  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }

  // ── ÉTAPE 2 : Refs Airtable (produits JuL uniquement) ────────────
  if (result.products) {
    for (const p of result.products) {
      const nom = (p.nom_propre || p.nom_original || '').trim();
      p.reference_believe = 'N/A';
      p.statut = 'introuvable';
      if (!nom) continue;

      // Cherche par nom dans les produits JuL
      const found = await findRef(nom);
      if (found) {
        p.reference_believe = found.ref;
        if (found.nom) p.nom_propre = found.nom;
        p.statut = 'trouve';
      } else {
        // Fallback : dernier produit JuL créé du même type
        const latest = await findLatestByCategory(p.type_produit || nom);
        if (latest) {
          p.reference_believe = latest.ref;
          p.nom_propre = latest.nom;
          p.statut = 'fallback';
        }
      }
    }
  }

  // ── ÉTAPE 3 : Message WhatsApp ────────────────────────────────────
  const d = result.destinataire || {};
  const lines = (result.products || []).map(p => {
    const note = p.statut === 'fallback' ? ' ⚠️ À vérifier' : '';
    return `${p.nom_propre || p.nom_original} | Réf: ${p.reference_believe || 'N/A'} | Qté: ${p.quantite || '?'} | Taille: ${p.taille || '?'}${note}`;
  }).join('\n');
  const alts = (result.alertes || []).map(a => a.message).join('\n');

  try {
    const r = await claudeCall(apiKey, [{ role: 'user', content:
      `Génère un message WhatsApp de confirmation de commande D'or et de Platine (boutique officielle JuL).
IMPORTANT : Utilise le tutoiement (tu/toi/ton/ta/tes) mais reste professionnel et courtois, sans familiarité excessive.
Utilise *gras*, emojis appropriés, séparateurs ━━━.

Produits :\n${lines}
Livraison : ${d.nom || '?'}, ${d.adresse || '?'}, ${d.telephone || '?'}
${alts ? '⚠️ Informations manquantes à signaler :\n' + alts : ''}

Retourne UNIQUEMENT le message WhatsApp.` }], 600);
    if (r.status === 200) result.message_whatsapp = getText(r.data);
  } catch(e) {}

  return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
};
