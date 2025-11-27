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
  
  // Pas deze ID's aan naar jouw testdata
  outboundSupplierId: "ef111c85-4315-4cde-bed9-efd29f25e19c", 
  inboundSupplierId:  "330a0188-1cda-4596-9715-23ddb4c33771"
};

// --- HTTP CLIENT SETUP ---
if (!fs.existsSync(CONFIG.pfxFile)) {
    console.error(`❌ Certificaat bestand niet gevonden: ${CONFIG.pfxFile}`);
    process.exit(1);
}

const httpsAgent = new https.Agent({
  pfx: fs.readFileSync(path.resolve(CONFIG.pfxFile)),
  passphrase: CONFIG.pfxPass,
  rejectUnauthorized: false 
});

const apiClient = axios.create({
  httpsAgent: httpsAgent,
  timeout: 30000
});

// --- HELPER: NETTE ERROR LOGGING ---
function handleAxiosError(error, context) {
    if (error.response) {
        // De server heeft geantwoord met een foutcode (4xx, 5xx)
        console.error(`❌ Fout bij ${context} (Status: ${error.response.status})`);
        // We loggen alleen de data payload, niet het hele request object
        console.error("   Details:", JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
        // Geen antwoord ontvangen
        console.error(`❌ Fout bij ${context}: Geen antwoord van server ontvangen.`);
    } else {
        // Configuratiefout
        console.error(`❌ Fout bij ${context}: ${error.message}`);
    }
}

// --- FUNCTIES ---

async function getAccessToken() {
  const authHeader = Buffer.from(`${CONFIG.clientId}:${CONFIG.clientSecret}`).toString('base64');
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');

  try {
      const response = await apiClient.post(CONFIG.tokenUrl, params, {
        headers: { 'Authorization': `Basic ${authHeader}`, 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      return response.data.access_token;
  } catch (error) {
      handleAxiosError(error, "Authenticatie");
      process.exit(1);
  }
}

async function getSupplierName(token, supplierId) {
    if (supplierId === CONFIG.outboundSupplierId) return "ABC Test Peppol B.V.";
    if (supplierId === CONFIG.inboundSupplierId) return "XYZ Test Peppol B.V.";
    if (!supplierId) return "Onbekend ID";
    
    try {
        const response = await apiClient.get(`${CONFIG.baseUrl}/suppliers/${supplierId}`, {
            headers: { "Authorization": `Bearer ${token}`, "Accept": "application/vnd.api+json" }
        });
        const names = response.data.data.attributes.names;
        return names && names.length > 0 ? names[0].value : "Naamloos";
    } catch (error) { return "Niet gevonden"; }
}

async function getInboundXmlData(token, documentId) {
    try {
        const response = await apiClient.get(`${CONFIG.baseUrl}/peppol/inbound-documents/${documentId}`, {
            headers: { "Authorization": `Bearer ${token}`, "Accept": "application/xml" },
            responseType: 'text'
        });
        const xml = response.data;
        const idMatch = xml.match(/<cbc:ID>([^<]+)<\/cbc:ID>/);
        const noteMatch = xml.match(/<cbc:Note>([^<]+)<\/cbc:Note>/);
        return { 
            invoiceNumber: idMatch ? idMatch[1] : "Niet gevonden", 
            description: noteMatch ? noteMatch[1] : "-" 
        };
    } catch (error) {
        return { invoiceNumber: "Fout", description: "Fout" };
    }
}

// --- HOOFD PROGRAMMA ---

async function main() {
  console.log("Authenticeren...");
  const token = await getAccessToken();
  console.log("✅ Data ophalen... even geduld.\n");

  // 1. OUTBOUND ophalen
  const fromDate = new Date();
  // FIX: Maximaal 6 dagen terug om API error te voorkomen
  fromDate.setDate(fromDate.getDate() - 6); 
  
  const outboundUrl = `${CONFIG.baseUrl}/peppol/documents?fromStatusChanged=${fromDate.toISOString()}&supplierId=${CONFIG.outboundSupplierId}&page[size]=50`;
  
  let latest10Outbound = [];
  try {
      const outboundRes = await apiClient.get(outboundUrl, {
        headers: { "Authorization": `Bearer ${token}`, "Accept": "application/vnd.api+json" }
      });
      
      latest10Outbound = (outboundRes.data.data || [])
          .sort((a, b) => new Date(b.attributes.createdAt) - new Date(a.attributes.createdAt))
          .slice(0, 10);
          
  } catch (error) {
      handleAxiosError(error, "Ophalen Outbound Documenten");
      return;
  }

  if (latest10Outbound.length === 0) { console.log("❌ Geen uitgaande facturen gevonden."); return; }

  // 2. INBOUND ophalen
  const inboundUrl = `${CONFIG.baseUrl}/peppol/inbound-documents?supplierId=${CONFIG.inboundSupplierId}&page[size]=100`;
  let inboundDocs = [];
  try {
      const inboundRes = await apiClient.get(inboundUrl, {
          headers: { "Authorization": `Bearer ${token}`, "Accept": "application/vnd.api+json" }
      });
      inboundDocs = inboundRes.data.data || [];
  } catch (error) {
      handleAxiosError(error, "Ophalen Inbound Documenten");
      // We gaan door, maar matchen zal falen
  }

  // 3. MATCHEN & PRINTEN
  console.log("================ RESULTATEN ===================\n");

  for (const outDoc of latest10Outbound) {
      const transId = outDoc.attributes.transmissionId;
      const match = inboundDocs.find(inDoc => inDoc.attributes.transmissionId === transId);
      const outName = await getSupplierName(token, CONFIG.outboundSupplierId);
      
      if (match) {
          const inId = match.relationships?.supplier?.data?.id;
          const inName = await getSupplierName(token, inId);
          const inDocId = match.id || match.attributes.id;
          const xmlData = await getInboundXmlData(token, inDocId);

          console.log(`✅ MATCH GEVONDEN`);
          console.log(`   Outbound supplierid    : ${CONFIG.outboundSupplierId} (${outName})`);
          console.log(`   Outbound factuurID     : ${outDoc.id}`);
          console.log(`   Factuurnummer (XML)    : ${xmlData.invoiceNumber}`);
          console.log(`   Betreft (XML)          : ${xmlData.description}`);
          console.log(`   Transmission FactuurID : ${transId}`);
          console.log(`   Inbound Supplier       : ${inId} (${inName})`);
          console.log(`   Inbound factuurID      : ${inDocId}`);
          console.log(`-----------------------------------------------------------------------------------\n`);
      } else {
          // console.log(`   (Geen match voor Outbound ID: ${outDoc.id})`);
      }
  }
  
  console.log("(Einde verwerking)");
}

main();