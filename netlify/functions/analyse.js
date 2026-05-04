const https = require('https');

const AIRTABLE_TOKEN = 'pataBCeGvhlN3N4Uq.cfa8a096a4b28fac19de4ea8006778cc5822fa610b9a2615cc144a4290e6a185';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function call(apiKey, body, mcp) {
  const payload = { ...body };
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };
  if (mcp) {
    payload.mcp_servers = [{ type: 'url', url: 'https://mcp.airtable.com/mcp', name: 'airtable', authorization_token: AIRTABLE_TOKEN }];
    headers['anthropic-beta'] = 'mcp-client-2025-04-04';
  }
  const s = JSON.stringify(payload);
  headers['Content-Length'] = Buffer.byteLength(s);
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers }, res => {
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

function txt(data) {
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
    ? '\nPhotos: ' + photoNames.join(' | ')
    : '';

  // ── ÉTAPE 1 : Analyse message (sans MCP) ─────────────────────────
  const p1 = `Assistant D'or et de Platine. Analyse ce message WhatsApp.${photosCtx}
CP→ville: 13012=Marseille 12e,75001=Paris 1er,69001=Lyon 1er,33000=Bordeaux,06000=Nice,31000=Toulouse,59000=Lille,44000=Nantes.
Alertes: adresse incomplète,quantité manquante,taille manquante(textile).
JSON UNIQUEMENT:
{"products":[{"nom_original":"","nom_propre":"nom exact site doretdeplatineshop.com","quantite":1,"taille":"","source":"texte"}],"destinataire":{"nom":"","adresse":"","telephone":""},"alertes":[{"type":"warning","message":""}]}
Message: ${message}`;

  let result;
  try {
    const r = await call(apiKey, { model: 'claude-sonnet-4-5', max_tokens: 800, messages: [{ role: 'user', content: p1 }] }, false);
    if (r.status !== 200) throw new Error(r.data.error?.message || 'Erreur step1 ' + r.status);
    result = parseJSON(txt(r.data));
  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }

  // ── ÉTAPE 2 : Refs Airtable via MCP (un appel, réponse ultra-courte) ──
  if (result.products && result.products.length > 0) {
    // Construire liste courte : index:nom
    const noms = result.products.map((p, i) => `${i + 1}:${p.nom_propre || p.nom_original}`).join('\n');

    // Prompt ultra-court : Claude fait search_records + list_records pour chaque produit
    // et retourne seulement un tableau JSON minimal
    const p2 = `Base Airtable: appouax19tnHJj0TD, table: tblGrm2yPn0ldTi01.
Pour chaque produit ci-dessous: 1) search_records avec les mots-clés du nom dans les champs ["Designation","Réf Believe"], 2) list_records_for_table avec le recordId trouvé et fieldIds ["fldba0MGx8lL3TQWS","fld02IfEMQb0zorrD"] pour lire la Réf Believe.
Réponds UNIQUEMENT avec ce tableau JSON sans rien d'autre:
[{"i":1,"r":"REF ou N/A"}]
Produits:
${noms}`;

    try {
      const r = await call(apiKey, {
        model: 'claude-sonnet-4-5',
        max_tokens: 150,
        messages: [{ role: 'user', content: p2 }]
      }, true);

      if (r.status === 200) {
        const t = txt(r.data);
        const s = t.indexOf('['), e = t.lastIndexOf(']');
        if (s >= 0 && e >= 0) {
          JSON.parse(t.substring(s, e + 1)).forEach(({ i, r }) => {
            const p = result.products[i - 1];
            if (p) { p.reference_believe = r || 'N/A'; p.statut = r && r !== 'N/A' ? 'trouve' : 'introuvable'; }
          });
        }
      }
    } catch(e) {
      result.products.forEach(p => { p.reference_believe = 'N/A'; p.statut = 'introuvable'; });
    }
  }

  // ── ÉTAPE 3 : Message WhatsApp (sans MCP) ────────────────────────
  const d = result.destinataire || {};
  const lines = (result.products || []).map(p =>
    `${p.nom_propre || p.nom_original}|${p.reference_believe || 'N/A'}|${p.quantite || '?'}|${p.taille || '?'}`
  ).join('\n');
  const alts = (result.alertes || []).map(a => a.message).join(', ');

  try {
    const r = await call(apiKey, {
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      messages: [{ role: 'user', content: `Message WhatsApp D'or et de Platine, tutoiement, *gras*, emojis, ━━━.
Produits(nom|ref|qte|taille):\n${lines}
Livraison: ${d.nom || '?'}, ${d.adresse || '?'}, ${d.telephone || '?'}
${alts ? 'Manquant: ' + alts : ''}
Retourne UNIQUEMENT le message.` }]
    }, false);
    if (r.status === 200) result.message_whatsapp = txt(r.data);
  } catch(e) {}

  return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
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
      if (!ins) { if (c === '{') ob++; else if (c === '}') ob--; if (c === '[') ob2++; else if (c === ']') ob2--; }
    }
    while (ob2 > 0) { str += ']'; ob2--; }
    while (ob > 0) { str += '}'; ob--; }
    return JSON.parse(str);
  }
}
