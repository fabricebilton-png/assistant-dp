const https = require('https');

const AIRTABLE_TOKEN  = 'pataBCeGvhlN3N4Uq.cfa8a096a4b28fac19de4ea8006778cc5822fa610b9a2615cc144a4290e6a185';
const AIRTABLE_BASE   = 'appouax19tnHJj0TD';
const AIRTABLE_TABLE  = 'tblGrm2yPn0ldTi01';
const F_REF     = 'fld02IfEMQb0zorrD';  // Réf Believe
const F_DESIGN  = 'fldba0MGx8lL3TQWS';  // Designation
const F_TYPE    = 'fldaWUTYOw5AMF65G';  // Type de produit (multipleRecordLinks → table tblXUMUccqHQ14J7W)
const F_ARTISTE = 'fldMRtaVIkYtBmEYM';  // Artiste/Marque
const F_CREATED = 'fldq1uaM2giuThUtK';  // Date de création
const JUL_ID    = 'recTpV0GW1YBPlT5d';  // ID JuL dans table ARTISTE

// Mapping type de produit (texte) → record ID dans table Type de produit
const TYPE_MAP = {
  'tshirt':        'recopycREObuH8WLs',
  't-shirt':       'recopycREObuH8WLs',
  'maillot':       'recopycREObuH8WLs',
  'sweat':         'rec5MVLblXOk3ozT3',
  'hoodie':        'rec5MVLblXOk3ozT3',
  'veste':         'recBpmBFHDt48VtDk',
  'manteau':       'recEPBPxWoO0dJ7dS',
  'pantalon':      'recOYouR99oIpxYCb',
  'jogging':       'recOYouR99oIpxYCb',
  'short':         'recx4xAJacGpDKtNZ',
  'sous-vetement': 'recdLR0VUsGdj1qNI',
  'boxer':         'recdLR0VUsGdj1qNI',
  'casquette':     'recTS7m9GuyBveIPF',
  'cap':           'recTS7m9GuyBveIPF',
  'bob':           'recKKrnndCJto5QK9',
  'bonnet':        'recWhx1mSLkbM6LmL',
  'cagoule':       'recWhx1mSLkbM6LmL',
  'claquette':     'rec8AlYCqT8E12Qys',
  'chaussure':     'rec3w82bwYraZIPiQ',
  'bijoux':        'recXLJesvXMm0bhQZ',
  'chevaliere':    'recXLJesvXMm0bhQZ',
  'chevalière':    'recXLJesvXMm0bhQZ',
  'coque':         'recanUiOxhR6NIaSZ',
  'sac':           'rec67CxicPg4rHctS',
  'goodie':        'reci9IZDacgN6Zjox',
  'accessoire':    'reci9IZDacgN6Zjox',
  'vinyle':        'rec4MqJAoJvpc2bLL',
  'cd':            'recC15GqwEvvbbuye',
  'usb':           'recCtUx5QZxq3wGER',
  'box':           'recGyWTYdZ4yjKVAi',
  'gants':         'recgQz9b1uaMxAHQw',
  'plage':         'recTLqTyigauqwjpa',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

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

// Recherche ref par mots-clés dans les produits JuL
async function findRef(nomProduit) {
  try {
    const stopwords = new Set(['maillot','casquette','sweat','short','pantalon','veste',
      'shirt','pack','coque','ensemble','survêtement','survetement','jogging',
      'chevaliere','chevalière','cagoule','coupe','imperméable','impermeable',
      'ballon','vinyle','album','tshirt','accessoire','sac','bob','claquette',
      'chaussette','boxer','briquet','porte','manteau','bonnet']);

    const mots = nomProduit.split(/[\s\-–—_\/\+]+/)
      .filter(w => w.length > 3 && !stopwords.has(w.toLowerCase()));
    const keywords = mots.length > 0
      ? mots.sort((a, b) => b.length - a.length).slice(0, 2)
      : nomProduit.split(/[\s\-–]+/).filter(w => w.length > 2).slice(0, 2);
    if (!keywords.length) return null;

    const julFilter = `FIND("${JUL_ID}", ARRAYJOIN({${F_ARTISTE}}, ",")) > 0`;
    const kwFilters = keywords.map(k => `SEARCH("${k.toLowerCase().replace(/['"]/g,'')}", LOWER({${F_DESIGN}}))`);
    const kwFormula = kwFilters.length > 1 ? `AND(${kwFilters.join(',')})` : kwFilters[0];
    const formula = `AND(${julFilter}, ${kwFormula})`;

    const qs = new URLSearchParams({ filterByFormula: formula, maxRecords: '5' });
    qs.append('fields[]', F_DESIGN);
    qs.append('fields[]', F_REF);

    const res = await airtableGet(`/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?${qs.toString()}`);
    if (res.records && res.records.length > 0) {
      let best = res.records[0], bestScore = 0;
      for (const r of res.records) {
        const nom = (r.fields[F_DESIGN] || '').toLowerCase();
        const score = keywords.filter(k => nom.includes(k.toLowerCase())).length;
        if (score > bestScore) { best = r; bestScore = score; }
      }
      const ref = best.fields[F_REF];
      if (ref) return { ref, nom: best.fields[F_DESIGN], fallback: false };
    }

    // Fallback OR sur un seul mot
    if (keywords.length > 1) {
      const formula2 = `AND(${julFilter}, ${kwFilters[0]})`;
      const qs2 = new URLSearchParams({ filterByFormula: formula2, maxRecords: '3' });
      qs2.append('fields[]', F_DESIGN);
      qs2.append('fields[]', F_REF);
      const res2 = await airtableGet(`/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?${qs2.toString()}`);
      if (res2.records && res2.records.length > 0) {
        const ref = res2.records[0].fields[F_REF];
        if (ref) return { ref, nom: res2.records[0].fields[F_DESIGN], fallback: false };
      }
    }
    return null;
  } catch(e) {
    console.error('findRef error:', nomProduit, e.message);
    return null;
  }
}

// Fallback : dernier produit JuL créé du même TYPE de produit
async function findLatestByType(typeProduit) {
  try {
    const typeKey = Object.keys(TYPE_MAP).find(k => (typeProduit || '').toLowerCase().includes(k));
    if (!typeKey) return null;
    const typeRecordId = TYPE_MAP[typeKey];

    const julFilter = `FIND("${JUL_ID}", ARRAYJOIN({${F_ARTISTE}}, ",")) > 0`;
    // Filtre sur Type de produit (multipleRecordLinks) via FIND sur l'ID du record lié
    const typeFilter = `FIND("${typeRecordId}", ARRAYJOIN({${F_TYPE}}, ",")) > 0`;
    const formula = `AND(${julFilter}, ${typeFilter})`;

    const qs = new URLSearchParams({ filterByFormula: formula, maxRecords: '1' });
    qs.append('fields[]', F_DESIGN);
    qs.append('fields[]', F_REF);
    qs.append('sort[0][field]', F_CREATED);
    qs.append('sort[0][direction]', 'desc');

    const res = await airtableGet(`/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?${qs.toString()}`);
    if (!res.records || res.records.length === 0) return null;

    const ref = res.records[0].fields[F_REF];
    const nom = res.records[0].fields[F_DESIGN];
    return ref ? { ref, nom, fallback: true } : null;
  } catch(e) {
    return null;
  }
}

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
      + photoNames.map((n,i) => `- Photo ${i+1}: ${n}`).join('\n')
    : '';

  // ── ÉTAPE 1 : Haiku analyse le message ───────────────────────────
  const p1 = `Tu es l'assistant de D'or et de Platine (boutique officielle JuL). Analyse ce message WhatsApp.${photosCtx}
CP→ville: 13012=Marseille 12e,75001=Paris 1er,69001=Lyon 1er,33000=Bordeaux,06000=Nice,31000=Toulouse,59000=Lille,44000=Nantes,76000=Rouen,67000=Strasbourg,13100=Aix-en-Provence.
Alertes: adresse incomplète,quantité manquante,taille manquante(textile).
Pour chaque produit, extrais le type exact parmi: t-shirt/sweat/veste/pantalon/short/casquette/bob/bonnet/cagoule/claquette/bijoux/chevalière/coque/sac/vinyle/cd/usb/box/goodie/accessoire.
JSON UNIQUEMENT:
{"products":[{"nom_original":"","nom_propre":"nom exact doretdeplatineshop.com","type_produit":"type exact","quantite":1,"taille":"","source":"texte ou photo"}],"destinataire":{"nom":"","adresse":"","telephone":""},"alertes":[{"type":"warning","message":""}]}
Message: ${message}`;

  let result;
  try {
    const r = await claudeCall(apiKey, [{ role: 'user', content: p1 }], 1200);
    if (r.status !== 200) throw new Error(r.data.error?.message || 'Erreur ' + r.status);
    result = parseJSON(getText(r.data));
  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }

  // ── ÉTAPE 2 : Refs Airtable (filtre JuL + type de produit) ───────
  if (result.products) {
    for (const p of result.products) {
      const nom = (p.nom_propre || p.nom_original || '').trim();
      p.reference_believe = 'N/A';
      p.statut = 'introuvable';
      if (!nom) continue;

      const found = await findRef(nom);
      if (found) {
        p.reference_believe = found.ref;
        if (found.nom) p.nom_propre = found.nom;
        p.statut = 'trouve';
      } else {
        // Fallback : dernier produit JuL du même type
        const latest = await findLatestByType(p.type_produit || nom);
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
    return `${p.nom_propre||p.nom_original} | Réf: ${p.reference_believe||'N/A'} | Qté: ${p.quantite||'?'} | Taille: ${p.taille||'?'}${note}`;
  }).join('\n');
  const alts = (result.alertes || []).map(a => a.message).join('\n');

  try {
    const r = await claudeCall(apiKey, [{ role: 'user', content:
      `Génère un message WhatsApp de confirmation D'or et de Platine. Tutoiement professionnel (tu/toi/ton), *gras*, emojis, ━━━.
Produits:\n${lines}
Livraison: ${d.nom||'?'}, ${d.adresse||'?'}, ${d.telephone||'?'}
${alts?'⚠️ Manquant:\n'+alts:''}
Retourne UNIQUEMENT le message WhatsApp.`
    }], 600);
    if (r.status === 200) result.message_whatsapp = getText(r.data);
  } catch(e) {}

  return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
};
