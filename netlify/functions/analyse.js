const https = require('https');

const AIRTABLE_TOKEN = 'pataBCeGvhlN3N4Uq.cfa8a096a4b28fac19de4ea8006778cc5822fa610b9a2615cc144a4290e6a185';
const BASE   = 'appouax19tnHJj0TD';
const TABLE  = 'tblGrm2yPn0ldTi01';
const F_REF     = 'fld02IfEMQb0zorrD';
const F_DESIGN  = 'fldba0MGx8lL3TQWS';
const F_ARTISTE = 'fldMRtaVIkYtBmEYM';
const F_TYPE    = 'fldaWUTYOw5AMF65G';
const F_CREATED = 'fldq1uaM2giuThUtK';
const JUL_ID    = 'recTpV0GW1YBPlT5d';

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
  'coque':'recanUiOxhR6NIaSZ','sac':'rec67CxicPg4rHctS',
  'vinyle':'rec4MqJAoJvpc2bLL','cd':'recC15GqwEvvbbuye','usb':'recCtUx5QZxq3wGER',
  'accessoire':'reci9IZDacgN6Zjox','goodie':'reci9IZDacgN6Zjox',
  'chaussette':'recdLR0VUsGdj1qNI','boxer':'recdLR0VUsGdj1qNI',
};

const CORS = {
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'Content-Type',
  'Access-Control-Allow-Methods':'POST, OPTIONS',
  'Content-Type':'application/json'
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers: headers || {} }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
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
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function claudePost(apiKey, body, useMcp) {
  const payload = { ...body };
  if (useMcp) {
    payload.mcp_servers = [{ type: 'url', url: 'https://mcp.airtable.com/mcp', name: 'airtable', authorization_token: AIRTABLE_TOKEN }];
  }
  const s = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(s),
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };
  if (useMcp) headers['anthropic-beta'] = 'mcp-client-2025-04-04';
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(s);
    req.end();
  });
}

function getText(data) {
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

// ── Recherche sur doretdeplatineshop.com ─────────────────────────────────────
async function searchSite(query) {
  try {
    const path = `/fr-fr/recherche?q=${encodeURIComponent(query)}&limit=5`;
    const res = await httpsGet('www.doretdeplatineshop.com', path, {
      'Accept': 'text/html',
      'User-Agent': 'Mozilla/5.0'
    });
    if (res.status !== 200) return null;

    // Extraire les noms de produits du HTML via regex sur les titres
    const matches = [];
    const regex = /class="[^"]*product[^"]*title[^"]*"[^>]*>\s*([^<]{5,80})/gi;
    let m;
    while ((m = regex.exec(res.body)) !== null && matches.length < 5) {
      const nom = m[1].trim().replace(/\s+/g, ' ');
      if (nom.length > 3) matches.push(nom);
    }
    // Fallback: chercher les balises <h2> ou <h3> qui ressemblent à des produits
    if (matches.length === 0) {
      const regex2 = /<(?:h2|h3|strong)[^>]*>\s*([A-Z][A-Z\s\-–0-9]{4,60})\s*<\/(?:h2|h3|strong)>/g;
      while ((m = regex2.exec(res.body)) !== null && matches.length < 5) {
        const nom = m[1].trim();
        if (nom.length > 3) matches.push(nom);
      }
    }
    return matches.length > 0 ? matches : null;
  } catch(e) {
    return null;
  }
}

// ── Fallback : N derniers produits JuL "En vente" par type ───────────────────
async function findLatestByType(typeProduit, n) {
  try {
    const key = Object.keys(TYPE_MAP).find(k => (typeProduit || '').toLowerCase().includes(k));
    if (!key) return [];
    const typeId = TYPE_MAP[key];
    const julFilter  = `FIND("${JUL_ID}", ARRAYJOIN({${F_ARTISTE}}, ",")) > 0`;
    const typeFilter = `FIND("${typeId}", ARRAYJOIN({${F_TYPE}}, ",")) > 0`;
    const formula    = `AND(${julFilter}, ${typeFilter}, {Etat}="En vente")`;
    const qs = new URLSearchParams({ filterByFormula: formula, maxRecords: String(n || 1) });
    qs.append('fields[]', F_DESIGN);
    qs.append('fields[]', F_REF);
    qs.append('sort[0][field]', F_CREATED);
    qs.append('sort[0][direction]', 'desc');
    const res = await airtableGet(`/v0/${BASE}/${TABLE}?${qs.toString()}`);
    return (res.records || []).map(r => ({ ref: r.fields[F_REF], nom: r.fields[F_DESIGN], fallback: true })).filter(r => r.ref);
  } catch(e) { return []; }
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
  if (!message) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Message manquant' }) };

  const photosCtx = photoNames.length > 0
    ? '\nPhotos doretdeplatineshop.com: ' + photoNames.join(' | ')
    : '';

  // ── ÉTAPE 1a : Recherche sur doretdeplatineshop.com pour enrichir l'analyse ──
  // Extraire les mots-clés du message et des photos pour chercher sur le site
  let siteContext = '';
  try {
    // Extraire les types de produits mentionnés dans le message
    const typesMentionnes = Object.keys(TYPE_MAP).filter(k => message.toLowerCase().includes(k));
    const photoKeywords = photoNames.map(n => n.split(/[\s\-–]+/).filter(w => w.length > 3).slice(0,2).join(' ')).filter(Boolean);
    const allKeywords = [...new Set([...photoKeywords, ...typesMentionnes.slice(0,2)])];

    const siteResults = [];
    for (const kw of allKeywords.slice(0, 3)) {
      const results = await searchSite(kw);
      if (results) siteResults.push(...results);
    }

    if (siteResults.length > 0) {
      siteContext = '\n\nProduits trouvés sur doretdeplatineshop.com correspondant à la commande:\n'
        + [...new Set(siteResults)].slice(0, 8).map(n => `- ${n}`).join('\n');
    }
  } catch(e) { /* silencieux */ }

  // ── ÉTAPE 1b : Haiku analyse le message + contexte site ─────────────────────
  const p1 = `Tu es l'assistant de D'or et de Platine (boutique officielle JuL). Analyse ce message WhatsApp.${photosCtx}${siteContext}

CP→ville: 13012=Marseille 12e,75001=Paris 1er,69001=Lyon 1er,33000=Bordeaux,06000=Nice,31000=Toulouse,59000=Lille,44000=Nantes,76000=Rouen,67000=Strasbourg,13090=Aix-en-Provence,13100=Aix-en-Provence.
RÈGLE TAILLES: "14 ans" ET "XS" → enfant pour 14 ans, adulte pour XS.
RÈGLE QUANTITÉ: N produits du même type vague → N lignes différentes du même type.
RÈGLE PHOTOS: Si des photos sont mentionnées (liste Photos ci-dessus), utilise TOUJOURS leur nom comme produit précis. est_vague=false si une photo est fournie. nom_propre = nom exact de la photo.
RÈGLE VAGUE: est_vague=true UNIQUEMENT si ni le texte ni les photos ne permettent d'identifier le produit (ex: "un t-shirt" sans aucune photo).
RÈGLE TYPE DEPUIS PHOTO: Si la photo donne un type vague (ex: "T-SHIRT NOIR LOGO OVNI"), extrais le type_produit=t-shirt et met est_vague=false pour chercher ce produit dans Airtable.
Alertes: adresse incomplète, quantité manquante, taille manquante (textile).

Pour chaque produit: type parmi t-shirt/sweat/veste/pantalon/short/casquette/bob/bonnet/cagoule/claquette/bijoux/chevalière/coque/sac/vinyle/cd/usb/goodie/accessoire/chaussette.

JSON UNIQUEMENT:
{"products":[{"nom_original":"","nom_propre":"nom exact tel qu'affiché sur doretdeplatineshop.com","type_produit":"","quantite":1,"taille":"","source":"texte ou photo","est_vague":false,"enfant":false}],"destinataire":{"nom":"","adresse":"","telephone":""},"alertes":[{"type":"warning","message":""}]}

Message: ${message}`;

  let result;
  try {
    const r = await claudePost(apiKey, { model: 'claude-haiku-4-5', max_tokens: 1200, messages: [{ role: 'user', content: p1 }] }, false);
    if (r.status !== 200) throw new Error(r.data.error?.message || 'Erreur step1 ' + r.status);
    result = parseJSON(getText(r.data));
  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }

  // ── ÉTAPE 2 : Claude + MCP Airtable pour les produits précis ────────────────
  const precis = (result.products || []).filter(p => !p.est_vague);
  const vagues  = (result.products || []).filter(p => p.est_vague);

  if (precis.length > 0) {
    const noms = precis.map((p, i) => `${i+1}. ${p.nom_propre || p.nom_original}`).join('\n');
    const p2 = `Base Airtable ${BASE}, table ${TABLE}.
Pour chaque produit, fais dans l'ordre:
1. search_records avec fields=["${F_DESIGN}","${F_REF}","${F_ARTISTE}","${F_ETAT || 'fldDNRg7YNU1CdOgP'}"] et la query=mots-clés du nom (sans les mots génériques comme casquette/tshirt/sweat/etc)
2. Parmi les résultats, garde ceux où Artiste contient "${JUL_ID}" ET Etat="En vente"
3. list_records_for_table avec le recordId valide et fieldIds=["${F_DESIGN}","${F_REF}"]
4. Lis cellValuesByFieldId["${F_REF}"]

Réponds UNIQUEMENT avec ce JSON:
[{"i":1,"ref":"REF ou N/A","nom":"nom Airtable"}]

Produits:
${noms}`;

    try {
      const r2 = await claudePost(apiKey, { model: 'claude-haiku-4-5', max_tokens: 400, messages: [{ role: 'user', content: p2 }] }, true);
      if (r2.status === 200) {
        const t = getText(r2.data);
        const s = t.indexOf('['), e = t.lastIndexOf(']');
        if (s >= 0 && e >= 0) {
          JSON.parse(t.substring(s, e + 1)).forEach(({ i, ref, nom }) => {
            const p = precis[i - 1];
            if (p) {
              p.reference_believe = (ref && ref !== 'N/A') ? ref : 'N/A';
              p.nom_propre = (nom && ref !== 'N/A') ? nom : p.nom_propre;
              p.statut = (ref && ref !== 'N/A') ? 'trouve' : 'introuvable';
            }
          });
        }
      }
    } catch(e) {
      precis.forEach(p => { p.reference_believe = 'N/A'; p.statut = 'introuvable'; });
    }
  }

  // Produits vagues → N derniers JuL "En vente" du même type via REST
  const vaguesExpanded = [];
  for (const p of vagues) {
    const n = p.quantite || 1;
    let found = [];
    if (p.enfant) found = await findLatestByType((p.type_produit || '') + ' enfant', n);
    if (found.length < n) {
      const more = await findLatestByType(p.type_produit || p.nom_original, n - found.length);
      found = [...found, ...more];
    }
    if (found.length > 0) {
      found.forEach(f => vaguesExpanded.push({ ...p, quantite: 1, nom_propre: f.nom, reference_believe: f.ref, statut: 'fallback' }));
    } else {
      vaguesExpanded.push({ ...p, reference_believe: 'N/A', statut: 'introuvable' });
    }
  }

  result.products = [...precis, ...vaguesExpanded];

  // ── ÉTAPE 3 : Message WhatsApp ────────────────────────────────────────────────
  const d = result.destinataire || {};
  const lines = result.products.map(p => {
    const note = p.statut === 'fallback' ? ' ⚠️ À vérifier' : '';
    return `${p.nom_propre||p.nom_original} | Réf: ${p.reference_believe||'N/A'} | Qté: ${p.quantite||1} | Taille: ${p.taille||'N/A'}${note}`;
  }).join('\n');
  const alts = (result.alertes||[]).map(a => a.message).join('\n');

  try {
    const r = await claudePost(apiKey, {
      model: 'claude-haiku-4-5', max_tokens: 600,
      messages: [{ role: 'user', content:
        `Message WhatsApp confirmation D'or et de Platine. Tutoiement professionnel (tu/toi/ton), *gras*, emojis, ━━━.
Produits:\n${lines}
Livraison: ${d.nom||'?'}, ${d.adresse||'?'}, ${d.telephone||'?'}
${alts?'⚠️ Manquant:\n'+alts:''}
Retourne UNIQUEMENT le message WhatsApp.` }]
    }, false);
    if (r.status === 200) result.message_whatsapp = getText(r.data);
  } catch(e) {}

  return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
};
