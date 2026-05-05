const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────
const AIRTABLE_TOKEN = 'pataBCeGvhlN3N4Uq.cfa8a096a4b28fac19de4ea8006778cc5822fa610b9a2615cc144a4290e6a185';
const BASE   = 'appouax19tnHJj0TD';
const TABLE  = 'tblGrm2yPn0ldTi01';
const F_REF     = 'fld02IfEMQb0zorrD'; // Réf Believe
const F_DESIGN  = 'fldba0MGx8lL3TQWS'; // Designation
const F_ARTISTE = 'fldMRtaVIkYtBmEYM'; // Artiste/Marque
const F_TYPE    = 'fldaWUTYOw5AMF65G'; // Type de produit
const F_ETAT    = 'fldDNRg7YNU1CdOgP'; // Etat
const F_CREATED = 'fldq1uaM2giuThUtK'; // Date de création
const JUL_ID    = 'recTpV0GW1YBPlT5d'; // ID JuL

// Mapping type de produit → record ID dans table Type de produit
const TYPE_MAP = {
  'tshirt':'recopycREObuH8WLs','t-shirt':'recopycREObuH8WLs','maillot':'recopycREObuH8WLs',
  'sweat':'rec5MVLblXOk3ozT3','hoodie':'rec5MVLblXOk3ozT3',
  'veste':'recBpmBFHDt48VtDk','manteau':'recEPBPxWoO0dJ7dS',
  'pantalon':'recOYouR99oIpxYCb','jogging':'recOYouR99oIpxYCb','survêtement':'recOYouR99oIpxYCb',
  'short':'recx4xAJacGpDKtNZ',
  'casquette':'recTS7m9GuyBveIPF','cap':'recTS7m9GuyBveIPF',
  'bob':'recKKrnndCJto5QK9',
  'bonnet':'recWhx1mSLkbM6LmL','cagoule':'recWhx1mSLkbM6LmL',
  'claquette':'rec8AlYCqT8E12Qys',
  'bijoux':'recXLJesvXMm0bhQZ','chevaliere':'recXLJesvXMm0bhQZ','chevalière':'recXLJesvXMm0bhQZ',
  'coque':'recanUiOxhR6NIaSZ',
  'sac':'rec67CxicPg4rHctS',
  'vinyle':'rec4MqJAoJvpc2bLL','cd':'recC15GqwEvvbbuye','usb':'recCtUx5QZxq3wGER',
  'accessoire':'reci9IZDacgN6Zjox','goodie':'reci9IZDacgN6Zjox',
  'chaussette':'recdLR0VUsGdj1qNI','boxer':'recdLR0VUsGdj1qNI',
  'chaussure':'rec3w82bwYraZIPiQ',
};

const CORS = {
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'Content-Type',
  'Access-Control-Allow-Methods':'POST, OPTIONS',
  'Content-Type':'application/json'
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────
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

// ── Recherche Airtable ────────────────────────────────────────────────────────
// Réplique exactement le workflow qui fonctionne ici :
// 1. search_records (keyword) → record IDs
// 2. list_records_for_table (recordId) → cellValuesByFieldId → Réf Believe

async function airtableSearch(keyword) {
  // Endpoint search Airtable (full-text, utilisé par le MCP)
  const path = `/v0/${BASE}/${TABLE}/search`
    + `?query=${encodeURIComponent(keyword)}`
    + `&fields[]=${F_DESIGN}&fields[]=${F_REF}&fields[]=${F_ARTISTE}&fields[]=${F_ETAT}`;
  return airtableGet(path);
}

async function airtableGetRecord(recordId) {
  // list_records_for_table avec recordId → cellValuesByFieldId
  const path = `/v0/${BASE}/${TABLE}`
    + `?records[]=${recordId}`
    + `&fields[]=${F_DESIGN}&fields[]=${F_REF}&fields[]=${F_ARTISTE}&fields[]=${F_ETAT}`;
  return airtableGet(path);
}

async function findRef(nomProduit, n) {
  // n = nombre de refs différentes à retourner (défaut 1)
  n = n || 1;
  try {
    // Stopwords à ignorer
    const stop = new Set(['maillot','casquette','sweat','short','pantalon','veste','shirt',
      'pack','coque','ensemble','survêtement','survetement','jogging','cagoule',
      'ballon','vinyle','tshirt','accessoire','sac','bob','claquette','bonnet',
      'chaussette','boxer','manteau','chevaliere','chevalière']);

    const mots = nomProduit.split(/[\s\-–—_\/\+]+/)
      .filter(w => w.length > 3 && !stop.has(w.toLowerCase()))
      .sort((a, b) => b.length - a.length);

    const keywords = mots.length > 0 ? mots.slice(0, 2) : nomProduit.split(/\s+/).filter(w => w.length > 2).slice(0, 2);
    if (!keywords.length) return [];

    const results = [];
    const usedRefs = new Set();

    for (const kw of keywords) {
      if (results.length >= n) break;

      // Étape 1 : search_records → record IDs
      const searchRes = await airtableSearch(kw);
      if (!searchRes.records || searchRes.records.length === 0) continue;

      // Étape 2 : pour chaque record ID, list_records_for_table → cellValuesByFieldId
      for (const rec of searchRes.records) {
        if (results.length >= n) break;

        const getRes = await airtableGetRecord(rec.id);
        if (!getRes.records || getRes.records.length === 0) continue;

        const fields = getRes.records[0].cellValuesByFieldId || {};
        const ref     = fields[F_REF];
        const nom     = fields[F_DESIGN];
        const artistes = fields[F_ARTISTE] || [];
        const etat     = fields[F_ETAT];

        // Filtres : JuL + En vente + pas déjà dans les résultats
        const isJul = artistes.some(a => a.id === JUL_ID);
        const isEnVente = etat && etat.name === 'En vente';

        if (ref && isJul && isEnVente && !usedRefs.has(ref)) {
          usedRefs.add(ref);
          results.push({ ref, nom, fallback: false });
          if (results.length >= n) break;
        }
      }
    }

    return results;
  } catch(e) {
    console.error('findRef error:', nomProduit, e.message);
    return [];
  }
}

// Fallback : N derniers produits JuL "En vente" par type de produit
async function findLatestByType(typeProduit, n) {
  n = n || 1;
  try {
    const key = Object.keys(TYPE_MAP).find(k => (typeProduit || '').toLowerCase().includes(k));
    if (!key) return [];
    const typeRecordId = TYPE_MAP[key];

    const julFilter  = `FIND("${JUL_ID}", ARRAYJOIN({${F_ARTISTE}}, ",")) > 0`;
    const typeFilter = `FIND("${typeRecordId}", ARRAYJOIN({${F_TYPE}}, ",")) > 0`;
    const etatFilter = `{Etat}="En vente"`;
    const formula    = `AND(${julFilter}, ${typeFilter}, ${etatFilter})`;

    const qs = new URLSearchParams({ filterByFormula: formula, maxRecords: String(n) });
    qs.append('fields[]', F_DESIGN);
    qs.append('fields[]', F_REF);
    qs.append('sort[0][field]', F_CREATED);
    qs.append('sort[0][direction]', 'desc');

    const res = await airtableGet(`/v0/${BASE}/${TABLE}?${qs.toString()}`);
    if (!res.records) return [];

    return res.records
      .map(r => ({ ref: r.fields[F_REF], nom: r.fields[F_DESIGN], fallback: true }))
      .filter(r => r.ref);
  } catch(e) {
    return [];
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

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: '{}' };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(e) {}

  const apiKey = (body.apiKey || '').trim();
  if (!apiKey.startsWith('sk-ant-'))
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Clé API invalide' }) };

  const { message, photoNames = [] } = body;
  if (!message)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Message manquant' }) };

  const photosCtx = photoNames.length > 0
    ? '\n\nProduits identifiés depuis les captures du site doretdeplatineshop.com :\n'
      + photoNames.map((n,i) => `- Photo ${i+1}: ${n}`).join('\n')
    : '';

  // ── ÉTAPE 1 : Haiku analyse le message ───────────────────────────────────────
  const p1 = `Tu es l'assistant de D'or et de Platine (boutique JuL). Analyse ce message WhatsApp.${photosCtx}

CP→ville: 13012=Marseille 12e,75001=Paris 1er,69001=Lyon 1er,33000=Bordeaux,06000=Nice,31000=Toulouse,59000=Lille,44000=Nantes,76000=Rouen,67000=Strasbourg,13100=Aix-en-Provence,13090=Aix-en-Provence.
Alertes: adresse incomplète,quantité manquante,taille manquante(textile).

RÈGLE TAILLES: si message mentionne "14 ans" ET "XS" → produits enfant pour 14 ans, adulte pour XS.
RÈGLE QUANTITÉ: si message indique N pour un type vague → N produits différents du même type.

Pour chaque produit, extrais:
- nom_propre: nom exact tel qu'affiché sur doretdeplatineshop.com (ou description si vague)
- type_produit: type exact parmi t-shirt/sweat/veste/pantalon/short/casquette/bob/bonnet/cagoule/claquette/bijoux/chevalière/coque/sac/vinyle/cd/usb/goodie/accessoire/chaussette
- quantite: nombre d'articles de ce type (si vague avec quantité → indiquer le nombre)
- taille: taille demandée ou N/A
- est_vague: true si le produit n'est pas précisément identifié (ex: "une casquette")
- enfant: true si taille enfant demandée

JSON UNIQUEMENT:
{"products":[{"nom_original":"","nom_propre":"","type_produit":"","quantite":1,"taille":"","source":"texte ou photo","est_vague":false,"enfant":false}],"destinataire":{"nom":"","adresse":"","telephone":""},"alertes":[{"type":"warning","message":""}]}

Message: ${message}`;

  let result;
  try {
    const r = await claudeCall(apiKey, [{ role: 'user', content: p1 }], 1200);
    if (r.status !== 200) throw new Error(r.data.error?.message || 'Erreur Claude ' + r.status);
    result = parseJSON(getText(r.data));
  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }

  // ── ÉTAPE 2 : Refs Airtable via search + get (même workflow que Claude ici) ──
  const enrichedProducts = [];

  if (result.products) {
    for (const p of result.products) {
      const nom = (p.nom_propre || p.nom_original || '').trim();
      const n   = p.quantite || 1;

      if (p.est_vague || !nom) {
        // Produit vague → N derniers produits JuL "En vente" du même type
        // Si enfant, ajouter "enfant" ou "kid" dans la recherche
        let found = [];
        if (p.enfant) {
          // Chercher version enfant d'abord
          found = await findRef(nom + ' enfant', n);
          if (found.length < n) {
            const more = await findRef(nom + ' kid', n - found.length);
            found = [...found, ...more];
          }
        }
        if (found.length < n) {
          const more = await findLatestByType(p.type_produit || nom, n - found.length);
          found = [...found, ...more];
        }

        if (found.length > 0) {
          found.forEach(f => enrichedProducts.push({
            ...p,
            quantite: 1,
            nom_propre: f.nom || p.nom_propre,
            reference_believe: f.ref,
            statut: f.fallback ? 'fallback' : 'trouve'
          }));
        } else {
          enrichedProducts.push({ ...p, quantite: 1, reference_believe: 'N/A', statut: 'introuvable' });
        }
      } else {
        // Produit précis → chercher par nom
        // Si enfant, chercher version enfant
        let found = [];
        if (p.enfant) {
          found = await findRef(nom + ' enfant', 1);
          if (!found.length) found = await findRef(nom + ' kid', 1);
        }
        if (!found.length) found = await findRef(nom, 1);

        if (found.length > 0) {
          enrichedProducts.push({
            ...p,
            nom_propre: found[0].nom || p.nom_propre,
            reference_believe: found[0].ref,
            statut: 'trouve'
          });
        } else {
          enrichedProducts.push({ ...p, reference_believe: 'N/A', statut: 'introuvable' });
        }
      }
    }
  }
  result.products = enrichedProducts;

  // ── ÉTAPE 3 : Message WhatsApp ────────────────────────────────────────────────
  const d = result.destinataire || {};
  const lines = enrichedProducts.map(p => {
    const note = p.statut === 'fallback' ? ' ⚠️ À vérifier' : '';
    return `${p.nom_propre||p.nom_original} | Réf: ${p.reference_believe||'N/A'} | Qté: ${p.quantite||1} | Taille: ${p.taille||'N/A'}${note}`;
  }).join('\n');
  const alts = (result.alertes||[]).map(a => a.message).join('\n');

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
