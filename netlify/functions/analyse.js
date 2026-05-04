const https = require('https');

const AIRTABLE_TOKEN = 'pataBCeGvhlN3N4Uq.cfa8a096a4b28fac19de4ea8006778cc5822fa610b9a2615cc144a4290e6a185';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function claudeCall(apiKey, body, useMcp) {
  const payload = { ...body };
  if (useMcp) {
    payload.mcp_servers = [{
      type: 'url',
      url: 'https://mcp.airtable.com/mcp',
      name: 'airtable',
      authorization_token: AIRTABLE_TOKEN
    }];
  }
  const s = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(s),
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    };
    if (useMcp) headers['anthropic-beta'] = 'mcp-client-2025-04-04';

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers
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

  const photos = photoNames.length > 0 ? '\nPhotos: ' + photoNames.join(', ') : '';

  // ── ÉTAPE 1 : Analyser le message, identifier les produits (sans Airtable) ─
  const step1 = `Assistant D'or et de Platine. Analyse ce message WhatsApp.${photos}
CP→ville (13012=Marseille 12e,75001=Paris 1er,69001=Lyon 1er,33000=Bordeaux,06000=Nice,31000=Toulouse,59000=Lille,44000=Nantes).
Alertes: adresse incomplète, quantité/taille manquante (textile).
JSON UNIQUEMENT:
{"products":[{"nom_original":"","nom_propre":"nom exact et complet du produit tel qu'il apparaît sur le site doretdeplatineshop.com","quantite":1,"taille":"","source":"texte"}],"destinataire":{"nom":"","adresse":"","telephone":""},"alertes":[{"type":"warning","message":""}]}
Message: ${message}`;

  let result;
  try {
    const r = await claudeCall(apiKey, {
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      messages: [{ role: 'user', content: step1 }]
    }, false);
    if (r.status !== 200) throw new Error(r.data.error?.message || 'Erreur step1');
    const text = (r.data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    result = parseJSON(text);
  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }

  // ── ÉTAPE 2 : Pour chaque produit, chercher la ref dans Airtable via MCP ──
  // Un seul appel Claude avec tous les noms à la fois pour limiter les tokens
  if (result.products && result.products.length > 0) {
    const noms = result.products.map((p, i) => `${i+1}. "${p.nom_propre || p.nom_original}"`).join('\n');
    const step2 = `Dans Airtable (base appouax19tnHJj0TD, table tblGrm2yPn0ldTi01), cherche la Réf Believe (champ fld02IfEMQb0zorrD) pour chaque produit suivant. Utilise search_records avec le nom complet du produit.
${noms}
Retourne UNIQUEMENT ce JSON sans markdown:
[{"index":1,"ref":"REF ou N/A"},{"index":2,"ref":"REF ou N/A"}]`;

    try {
      const r = await claudeCall(apiKey, {
        model: 'claude-sonnet-4-5',
        max_tokens: 300,
        messages: [{ role: 'user', content: step2 }]
      }, true);

      if (r.status === 200) {
        const text = (r.data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        const clean = text.replace(/```json\s*/g,'').replace(/```\s*/g,'').trim();
        const s = clean.indexOf('['), e = clean.lastIndexOf(']');
        if (s >= 0 && e >= 0) {
          const refs = JSON.parse(clean.substring(s, e+1));
          refs.forEach(r => {
            const p = result.products[r.index - 1];
            if (p) {
              p.reference_believe = r.ref || 'N/A';
              p.statut = r.ref && r.ref !== 'N/A' ? 'trouve' : 'introuvable';
            }
          });
        }
      }
    } catch(e) {
      console.error('Step2 error:', e.message);
      result.products.forEach(p => { p.reference_believe = 'N/A'; p.statut = 'introuvable'; });
    }
  }

  // ── ÉTAPE 3 : Générer le message WhatsApp ─────────────────────────────────
  const d = result.destinataire || {};
  const prodLines = (result.products || []).map(p =>
    `- ${p.nom_propre||p.nom_original} | Réf: ${p.reference_believe||'N/A'} | Qté: ${p.quantite||'?'} | Taille: ${p.taille||'?'}`
  ).join('\n');
  const alertes = (result.alertes || []).map(a => `⚠️ ${a.message}`).join('\n');

  const step3 = `Message WhatsApp confirmation commande D'or et de Platine. Tutoiement, *gras*, emojis, ━━━.
Produits:\n${prodLines}
Livraison: ${d.nom||'?'}, ${d.adresse||'?'}, ${d.telephone||'?'}
${alertes?'Manquant:\n'+alertes:''}
Retourne UNIQUEMENT le message.`;

  try {
    const r = await claudeCall(apiKey, {
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      messages: [{ role: 'user', content: step3 }]
    }, false);
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
