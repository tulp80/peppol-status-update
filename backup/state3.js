import 'dotenv/config';
import axios from 'axios';
import https from 'https';
import fs from 'fs';
import path from 'path';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = Object.freeze({
  api: {
    baseUrl: process.env.BASE_URL,
    tokenUrl: process.env.TOKEN_URL,
  },
  auth: {
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
  },
  ssl: {
    pfxFile: process.env.PFX_FILE || 'client_fullchain_with_password.pfx',
    passphrase: process.env.SSL_PASSPHRASE,
  },
  // Specifieke document ID uit terminal output
  documentId: 'b6d0c896-1ec7-4817-b826-36bb663da1ab',
});

// ============================================================================
// LOGGER
// ============================================================================

const Logger = {
  info: (msg) => console.log(`ℹ️  ${msg}`),
  success: (msg) => console.log(`✅ ${msg}`),
  error: (msg) => console.error(`❌ ${msg}`),
  separator: () => console.log('-'.repeat(80)),
  blank: () => console.log(''),
  header: (msg) => {
    Logger.blank();
    console.log(`${'='.repeat(20)} ${msg} ${'='.repeat(20)}`);
    Logger.blank();
  },
};

// ============================================================================
// HTTP CLIENT
// ============================================================================

function createHttpClient() {
  const { pfxFile, passphrase } = CONFIG.ssl;

  if (!fs.existsSync(pfxFile)) {
    throw new Error(`SSL certificate not found: ${pfxFile}`);
  }

  const httpsAgent = new https.Agent({
    pfx: fs.readFileSync(path.resolve(pfxFile)),
    passphrase,
    rejectUnauthorized: false,
  });

  return axios.create({
    httpsAgent,
    timeout: 30000,
  });
}

// ============================================================================
// API SERVICE
// ============================================================================

class PeppolApiService {
  constructor(httpClient) {
    this.client = httpClient;
    this.token = null;
  }

  async authenticate() {
    const { clientId, clientSecret } = CONFIG.auth;
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await this.client.post(
      CONFIG.api.tokenUrl,
      new URLSearchParams({ grant_type: 'client_credentials' }),
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    this.token = response.data.access_token;
    return this.token;
  }

  get authHeaders() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.api+json',
    };
  }

  get jsonApiHeaders() {
    return {
      ...this.authHeaders,
      'Content-Type': 'application/vnd.api+json',
    };
  }

  async fetchInboundBusinessStatuses(documentId) {
    const url = `${CONFIG.api.baseUrl}/peppol/inbound-documents/${documentId}/business-statuses`;

    const response = await this.client.get(url, {
      headers: this.authHeaders,
    });

    return response.data.data || [];
  }

  async sendBusinessStatus(documentId, statusCode) {
    const url = `${CONFIG.api.baseUrl}/peppol/inbound-documents/${documentId}/business-statuses`;

    const payload = {
      data: {
        type: 'peppolInboundDocumentBusinessStatus',
        attributes: {
          code: statusCode,
        },
      },
    };

    const response = await this.client.post(url, payload, {
      headers: this.jsonApiHeaders,
    });

    return response.data.data;
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  try {
    Logger.header('REJECTED STATUS VERSTUREN');
    
    Logger.info('Authenticeren...');
    const httpClient = createHttpClient();
    const apiService = new PeppolApiService(httpClient);

    await apiService.authenticate();
    Logger.success('Token verkregen.');

    Logger.blank();
    Logger.info(`Document ID: ${CONFIG.documentId}`);
    
    // Huidige status ophalen
    Logger.info('Huidige status ophalen...');
    const currentStatuses = await apiService.fetchInboundBusinessStatuses(CONFIG.documentId);
    
    if (currentStatuses.length > 0) {
      // Sorteer op datum (nieuwste eerst)
      const sorted = [...currentStatuses].sort(
        (a, b) => new Date(b.attributes.createdAt) - new Date(a.attributes.createdAt)
      );
      const latestStatus = sorted[0].attributes;
      
      Logger.info(`Huidige status: ${latestStatus.code}`);
      Logger.info(`Technical status: ${latestStatus.technicalStatus || '-'}`);
      
      // Controleer of het al een final status is
      if (latestStatus.code === 'accepted' || latestStatus.code === 'rejected') {
        Logger.separator();
        Logger.error(`⚠️  Kan rejected niet versturen: document heeft al status "${latestStatus.code}"`);
        Logger.error(`   De API staat geen transitie van "${latestStatus.code}" naar "rejected" toe.`);
        Logger.separator();
        process.exit(1);
      }
    } else {
      Logger.info('Geen huidige status gevonden.');
    }
    
    Logger.blank();
    Logger.info('Rejected status versturen...');
    Logger.separator();

    const result = await apiService.sendBusinessStatus(CONFIG.documentId, 'rejected');
    
    Logger.success(`✅ Rejected status succesvol verstuurd!`);
    Logger.info(`Status ID: ${result.id}`);
    Logger.info(`Technical Status: ${result.attributes.technicalStatus}`);
    Logger.separator();
    
  } catch (error) {
    Logger.error(`Fout: ${error.message}`);
    if (error.response?.data) {
      const errorDetail = error.response.data.errors?.[0]?.detail || JSON.stringify(error.response.data, null, 2);
      Logger.error(`Details: ${errorDetail}`);
      
      // Specifieke melding voor de "cannot transition" fout
      if (error.response.status === 403 && errorDetail.includes('Cannot transition')) {
        Logger.blank();
        Logger.error('⚠️  Het document heeft al een final status (accepted/rejected) en kan niet meer gewijzigd worden.');
      }
    }
    Logger.separator();
    process.exit(1);
  }
}

main();

