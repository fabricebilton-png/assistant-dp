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

// Recherche via filterByFormula (API REST standard Airtable)
// Même logique que search_records + list_records_for_table
async function findRef(nomProduit) {
  try {
    // Extraire mots discriminants
    const stopwords = new Set(['maillot','casquette','sweat','short','pantalon','veste',
      'shirt','pack','coque','ensemble','survêtement','survetement','jogging',
      'chevaliere','chevalière','cagoule','coupe','imperméable','impermeable',
      'tshirt','ballon','vinyle','album']);

    const mots = nomProduit.split(/[\s\-–—_\/]+/)
      .filter(w => w.length > 3 && !stopwords.has(w.toLowerCase()));

    const keywords = mots.length > 0
      ? mots.sort((a, b) => b.length - a.length).slice(0, 2)
      : nomProduit.split(/[\s\-–]+/).filter(w => w.length > 2).slice(0, 2);

    if (keywords.length === 0) return null;

    // Construire formula SEARCH pour chaque mot-clé
    const conditions = keywords.map(k =>
      `SEARCH("${k.toLowerCase().replace(/"/g,'')}", LOWER({${F_DESIGN}}))`
    );
    const formula = conditions.length > 1
      ? `AND(${conditions.join(',')})`
      : conditions[0];

    const path = `/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`
      + `?filterByFormula=${encodeURIComponent(formula)}`
      + `&fields[]=${F_DESIGN}&fields[]=${F_REF}`
      + `&maxRecords=3`;

    const res = await airtableGet(path);

    if (!res.records || res.records.length === 0) {
      // Fallback : chercher avec un seul mot si AND ne donne rien
      if (keywords.length > 1) {
        const formula2 = `SEARCH("${keywords[0].toLowerCase().replace(/"/g,'')}", LOWER({${F_DESIGN}}))`;
        const path2 = `/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`
          + `?filterByFormula=${encodeURIComponent(formula2)}`
          + `&fields[]=${F_DESIGN}&fields[]=${F_REF}`
          + `&maxRecords=3`;
        const res2 = await airtableGet(path2);
        if (!res2.records || res2.records.length === 0) return null;
        const fields2 = res2.records[0].fields || {};
        return fields2[F_REF] || fields2['Réf Believe'] || null;
      }
      return null;
    }

    // Lire les champs — l'API REST retourne dans .fields (pas cellValuesByFieldId)
    const fields = res.records[0].fields || {};
    return fields[F_REF] || fields['Réf Believe'] || null;

  } catch(e) {
    console.error('findRef error:', nomProduit, e.message);
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
    ? '\nProduits identifiés depuis les captures du site doretdeplatineshop.com:\n'
      + photoNames.map((n,i) => `- Photo ${i+1}: ${n}`).join('\n')
    : '';

  // ── ÉTAPE 1 : Haiku analyse le message ───────────────────────────
  const p1 = `Assistant D'or et de Platine. Analyse ce message WhatsApp et extrait TOUS les produits et infos de livraison.${photosCtx}
CP→ville: 13012=Marseille 12e,75001=Paris 1er,69001=Lyon 1er,33000=Bordeaux,06000=Nice,31000=Toulouse,59000=Lille,44000=Nantes,76000=Rouen,67000=Strasbourg,13100=Aix-en-Provence.
Alertes: adresse incomplète,quantité manquante,taille manquante(textile).
JSON UNIQUEMENT:
{"products":[{"nom_original":"","nom_propre":"nom exact tel qu'affiché sur doretdeplatineshop.com","quantite":1,"taille":"","source":"texte ou photo"}],"destinataire":{"nom":"","adresse":"adresse complète avec ville déduite","telephone":""},"alertes":[{"type":"warning","message":""}]}
Message: ${message}`;

  let result;
  try {
    const r = await claudeCall(apiKey, [{ role: 'user', content: p1 }], 1000);
    if (r.status !== 200) throw new Error(r.data.error?.message || 'Erreur step1 ' + r.status);
    result = parseJSON(getText(r.data));
  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }

  // ── ÉTAPE 2 : Chercher refs via Airtable REST filterByFormula ─────
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

  // ── ÉTAPE 3 : Haiku génère le message WhatsApp ───────────────────
  const d = result.destinataire || {};
  const lines = (result.products || []).map(p =>
    `${p.nom_propre||p.nom_original} | Réf: ${p.reference_believe||'N/A'} | Qté: ${p.quantite||'?'} | Taille: ${p.taille||'?'}`
  ).join('\n');
  const alts = (result.alertes || []).map(a => a.message).join('\n');

  try {
    const r = await claudeCall(apiKey, [{ role: 'user', content:
      `Message WhatsApp confirmation D'or et de Platine. Tutoiement, *gras*, emojis, ━━━.
Produits:\n${lines}
Livraison: ${d.nom||'?'}, ${d.adresse||'?'}, ${d.telephone||'?'}
${alts?'⚠️ Manquant:\n'+alts:''}
Retourne UNIQUEMENT le message WhatsApp.` }], 500);
    if (r.status === 200) result.message_whatsapp = getText(r.data);
  } catch(e) {}

  return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
};
