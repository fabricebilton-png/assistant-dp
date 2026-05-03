const https = require('https');

const AIRTABLE_TOKEN = 'pataBCeGvhlN3N4Uq.cfa8a096a4b28fac19de4ea8006778cc5822fa610b9a2615cc144a4290e6a185';
const AIRTABLE_BASE = 'appouax19tnHJj0TD';
const AIRTABLE_TABLE = 'tblGrm2yPn0ldTi01';
const FIELD_DESIGNATION = 'fldba0MGx8lL3TQWS';
const FIELD_REF = 'fld02IfEMQb0zorrD';

function httpsGet(path, token) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.airtable.com', path, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', e => resolve({ status: 500, body: '{}' }));
    req.end();
  });
}

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve) => {
    const req = https.request({ hostname, path, method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', e => resolve({ status: 500, body: JSON.stringify({ error: { message: e.message } }) }));
    req.write(body);
    req.end();
  });
}

exports.handler = async function(event) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: '{}' };

  let bodyObj = {};
  try { bodyObj = JSON.parse(event.body || '{}'); } catch(e) {}

  // ── AIRTABLE SEARCH ─────────────────────────────────────────────
  if (bodyObj.action === 'airtable-search') {
    const q = (bodyObj.query || '').replace(/["']/g, '').substring(0, 50).toLowerCase();
    if (!q) return { statusCode: 200, headers: cors, body: JSON.stringify({ records: [] }) };

    const formula = `OR(SEARCH("${q}",LOWER({${FIELD_DESIGNATION}})),SEARCH("${q}",LOWER({${FIELD_REF}})))`;
    const path = `/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?filterByFormula=${encodeURIComponent(formula)}&fields[]=${FIELD_DESIGNATION}&fields[]=${FIELD_REF}&maxRecords=5`;

    const result = await httpsGet(path, AIRTABLE_TOKEN);
    try {
      const data = JSON.parse(result.body);
      if (data.records) {
        data.records = data.records.map(r => ({
          id: r.id,
          fields: {
            'Designation': (r.fields || {})[FIELD_DESIGNATION] || '',
            'Réf Believe': (r.fields || {})[FIELD_REF] || ''
          }
        }));
      }
      return { statusCode: 200, headers: cors, body: JSON.stringify(data) };
    } catch(e) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ records: [] }) };
    }
  }

  // ── CLAUDE API — clé saisie par l'utilisateur ────────────────────
  // La clé est dans le body, envoyée depuis le champ en haut à droite
  const apiKey = (bodyObj.apiKey || '').trim();
  if (!apiKey.startsWith('sk-ant-')) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: { message: 'Clé API invalide — vérifiez le champ en haut à droite' } }) };
  }

  const { apiKey: _removed, ...cleanBody } = bodyObj;
  const bodyStr = JSON.stringify(cleanBody);

  const result = await httpsPost(
    'api.anthropic.com', '/v1/messages',
    {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    bodyStr
  );

  return { statusCode: result.status, headers: cors, body: result.body };
};
