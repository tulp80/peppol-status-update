import 'dotenv/config';
import axios from 'axios';
import https from 'https';
import fs from 'fs';
import path from 'path';

// --- CONFIGURATIE ---
const CONFIG = {
  baseUrl: process.env.BASE_URL,
  tokenUrl: process.env.TOKEN_URL,
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  pfxFile: process.env.PFX_FILE || 'client_fullchain_with_password.pfx',
  pfxPass: process.env.SSL_PASSPHRASE,
  
  outboundSupplierId: "ef111c85-4315-4cde-bed9-efd29f25e19c",
  inboundSupplierId:  "330a0188-1cda-4596-9715-23ddb4c33771"
};

// --- HTTP SETUP ---
if (!fs.existsSync(CONFIG.pfxFile)) process.exit(1);

const httpsAgent = new https.Agent({
  pfx: fs.readFileSync(path.resolve(CONFIG.pfxFile)),
  passphrase: CONFIG.pfxPass,
  rejectUnauthorized: false 
});

const apiClient = axios.create({ httpsAgent, timeout: 30000 });

// --- HELPERS ---
function logError(context, error) {
    if (error.response) {
        console.error(`❌ Fout bij ${context}: ${error.response.status}`);
    } else {
        console.error(`❌ Fout bij ${context}: ${error.message}`);
    }
}

async function getAccessToken() {
  const authHeader = Buffer.from(`${CONFIG.clientId}:${CONFIG.clientSecret}`).toString('base64');
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  try {
      const res = await apiClient.post(CONFIG.tokenUrl, params, {
        headers: { 'Authorization': `Basic ${authHeader}`, 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      return res.data.access_token;
  } catch (e) { logError("Authenticatie", e); process.exit(1); }
}

async function getXmlDetails(token, docId) {
    try {
        const res = await apiClient.get(`${CONFIG.baseUrl}/peppol/inbound-documents/${docId}`, {
            headers: { "Authorization": `Bearer ${token}`, "Accept": "application/xml" },
            responseType: 'text'
        });
        const xml = res.data;
        const idMatch = xml.match(/<cbc:ID>([^<]+)<\/cbc:ID>/);
        const noteMatch = xml.match(/<cbc:Note>([^<]+)<\/cbc:Note>/);
        return { 
            nr: idMatch ? idMatch[1] : "Niet gevonden", 
            desc: noteMatch ? noteMatch[1] : "-" 
        };
    } catch (e) { return { nr: "Error", desc: "Error" }; }
}

async function getInboundBusinessStatus(token, docId) {
    try {
        const res = await apiClient.get(`${CONFIG.baseUrl}/peppol/inbound-documents/${docId}/business-statuses`, {
            headers: { "Authorization": `Bearer ${token}`, "Accept": "application/vnd.api+json" }
        });
        const statuses = res.data.data || [];
        if (statuses.length > 0) {
            const latest = statuses.sort((a, b) => new Date(b.attributes.createdAt) - new Date(a.attributes.createdAt))[0];
            return latest.attributes.code || "-";
        }
        return "-";
    } catch (e) { return "-"; }
}

// --- MAIN ---
async function main() {
  console.log("Authenticeren...");
  const token = await getAccessToken();
  console.log("✅ Token OK. Data ophalen...\n");

  // 1. Haal INBOUND op
  let inboundDocs = [];
  try {
      const res = await apiClient.get(`${CONFIG.baseUrl}/peppol/inbound-documents?supplierId=${CONFIG.inboundSupplierId}&page[size]=20`, {
          headers: { "Authorization": `Bearer ${token}`, "Accept": "application/vnd.api+json" }
      });
      inboundDocs = res.data.data || [];
  } catch (e) { logError("Inbound fetch", e); }

  if (inboundDocs.length === 0) { console.log("❌ Geen inkomende facturen gevonden."); return; }

  // 2. Haal OUTBOUND op
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 6);
  let outboundMap = new Map();
  
  try {
      const res = await apiClient.get(`${CONFIG.baseUrl}/peppol/documents?supplierId=${CONFIG.outboundSupplierId}&fromStatusChanged=${fromDate.toISOString()}&page[size]=100`, {
          headers: { "Authorization": `Bearer ${token}`, "Accept": "application/vnd.api+json" }
      });
      (res.data.data || []).forEach(doc => {
          if (doc.attributes.transmissionId) {
              outboundMap.set(doc.attributes.transmissionId, doc);
          }
      });
  } catch (e) { logError("Outbound fetch", e); }

  // 3. VERGELIJK & PRINT
  console.log("================ RESULTATEN ===================\n");
  
  let matchCount = 0;

  for (const inDoc of inboundDocs) {
      const transId = inDoc.attributes.transmissionId;
      
      if (outboundMap.has(transId)) {
          matchCount++;
          const outDoc = outboundMap.get(transId);
          
          const xmlData = await getXmlDetails(token, inDoc.id);
          const inboundState = await getInboundBusinessStatus(token, inDoc.id);

          console.log(`Factuurnummer (BIS 3.0 DOC.)   : ${xmlData.nr}`);
          console.log(``);
          console.log(`Betreft (BIS 3.0 DOC.)         : ${xmlData.desc}`);
          console.log(``);
          console.log(`Outbound Supplier              : ABC Test Peppol B.V. (${CONFIG.outboundSupplierId})`);
          console.log(`Outbound FactuurID             : ${outDoc.id}`);
          console.log(`Outbound Created DateTime      : ${outDoc.attributes.createdAt}`);
          console.log(`Outbound business-state        : ${outDoc.attributes.businessStatus || "-"}`);
          console.log(``);
          console.log(`Transmission FactuurID         : ${transId}`);
          console.log(``);
          console.log(`Inbound Supplier               : XYZ Test Peppol B.V. (${CONFIG.inboundSupplierId})`);
          console.log(`Inbound FactuurID              : ${inDoc.id}`);
          console.log(`Inbound Created DateTime       : ${inDoc.attributes.createdAt}`);
          console.log(`Inbound state                  : ${inboundState}`);
          console.log(`-----------------------------------------------------------------------------------\n`);
      }
  }

  if (matchCount === 0) {
      console.log("❌ Geen matches gevonden.");
  }
}

main();
