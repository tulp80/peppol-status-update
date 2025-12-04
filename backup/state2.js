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
  suppliers: {
    outbound: {
      id: 'ef111c85-4315-4cde-bed9-efd29f25e19c',
      name: 'ABC Test Peppol B.V. (Administratie Tenant: 035058)',
    },
    inbound: {
      id: '330a0188-1cda-4596-9715-23ddb4c33771',
      name: 'XYZ Test Peppol B.V. (Administratie Tenant: 034946)',
    },
  },
  settings: {
    pageSize: 100,
    lookbackDays: 6,
    timeout: 30000,
    finalStatusWaitTime: 30000,
    outputDir: './reports',
  },
  businessStatus: {
    codes: {
      ACCEPTED: 'accepted',
      REJECTED: 'rejected',
    },
    get allStatuses() {
      return Object.values(this.codes);
    },
    get finalStatuses() {
      return [this.codes.ACCEPTED, this.codes.REJECTED];
    },
  },
});

// ============================================================================
// LOGGER
// ============================================================================

const Logger = {
  info: (msg) => console.log(`ℹ️  ${msg}`),
  success: (msg) => console.log(`✅ ${msg}`),
  error: (msg) => console.error(`❌ ${msg}`),
  warning: (msg) => console.log(`⚠️  ${msg}`),
  separator: () => console.log('-'.repeat(80)),
  blank: () => console.log(''),
  header: (msg) => {
    Logger.blank();
    console.log(`${'='.repeat(20)} ${msg} ${'='.repeat(20)}`);
    Logger.blank();
  },
};

// ============================================================================
// UTILITIES
// ============================================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const randomChoice = (options) => options[Math.floor(Math.random() * options.length)];

const formatTimestamp = (date = new Date()) => {
  return date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
};

// ============================================================================
// FILE WRITER
// ============================================================================

class ReportFileWriter {
  constructor(outputDir) {
    this.outputDir = outputDir;
    this.lines = [];
    this.filename = null;
  }

  init() {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
    this.filename = path.join(this.outputDir, `${formatTimestamp()}.txt`);
    this.lines = [];
  }

  addLine(text = '') {
    this.lines.push(text);
  }

  addSeparator() {
    this.lines.push('-'.repeat(80));
  }

  addBlank() {
    this.lines.push('');
  }

  save() {
    const content = this.lines.join('\n');
    fs.writeFileSync(this.filename, content, 'utf8');
    return this.filename;
  }
}

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
    timeout: CONFIG.settings.timeout,
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

  async fetchOutboundDocuments(supplierId, fromDate) {
    const url = `${CONFIG.api.baseUrl}/peppol/documents`;
    const params = {
      supplierId,
      fromStatusChanged: fromDate.toISOString(),
      'page[size]': CONFIG.settings.pageSize,
    };

    const response = await this.client.get(url, {
      headers: this.authHeaders,
      params,
    });

    return response.data.data || [];
  }

  async fetchInboundDocuments(supplierId) {
    const url = `${CONFIG.api.baseUrl}/peppol/inbound-documents`;
    const params = {
      supplierId,
      'page[size]': CONFIG.settings.pageSize,
    };

    const response = await this.client.get(url, {
      headers: this.authHeaders,
      params,
    });

    return response.data.data || [];
  }

  async fetchDocumentXml(documentId) {
    const url = `${CONFIG.api.baseUrl}/peppol/inbound-documents/${documentId}`;

    const response = await this.client.get(url, {
      headers: { ...this.authHeaders, Accept: 'application/xml' },
      responseType: 'text',
    });

    return response.data;
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
// DATA EXTRACTORS
// ============================================================================

const XmlParser = {
  extractField(xml, tagName) {
    const regex = new RegExp(`<cbc:${tagName}>([^<]+)</cbc:${tagName}>`);
    const match = xml.match(regex);
    return match ? match[1] : null;
  },

  parseInvoiceDetails(xml) {
    const issueDate = this.extractField(xml, 'IssueDate');
    return {
      invoiceNumber: this.extractField(xml, 'ID') || 'Niet gevonden',
      description: this.extractField(xml, 'Note') || '-',
      issueDate: issueDate ? new Date(issueDate) : null,
    };
  },
};

const StatusResolver = {
  getLatestStatus(statuses) {
    if (!statuses.length) {
      return { code: '-', technicalStatus: '-' };
    }

    const sorted = [...statuses].sort(
      (a, b) => new Date(b.attributes.createdAt) - new Date(a.attributes.createdAt)
    );

    const latest = sorted[0].attributes;
    return {
      code: latest.code || '-',
      technicalStatus: latest.technicalStatus || '-',
    };
  },

  hasStatus(statuses, statusCode) {
    return statuses.some((s) => s.attributes.code === statusCode);
  },

  hasAnyStatus(statuses, statusCodes) {
    return statuses.some((s) => statusCodes.includes(s.attributes.code));
  },

  getExistingStatusCodes(statuses) {
    return statuses.map((s) => s.attributes.code);
  },
};

// ============================================================================
// BUSINESS STATUS MANAGER
// ============================================================================

class BusinessStatusManager {
  constructor(apiService) {
    this.api = apiService;
  }

  async analyzeDocument(documentId) {
    const statuses = await this.api.fetchInboundBusinessStatuses(documentId);
    const { finalStatuses } = CONFIG.businessStatus;

    const hasFinalStatus = StatusResolver.hasAnyStatus(statuses, finalStatuses);
    const existingCodes = StatusResolver.getExistingStatusCodes(statuses);

    return {
      statuses,
      hasFinalStatus,
      existingCodes,
      needsFinalStatus: !hasFinalStatus,
      isComplete: hasFinalStatus,
    };
  }

  async sendStatus(documentId, statusCode) {
    try {
      const response = await this.api.sendBusinessStatus(documentId, statusCode);
      return {
        success: true,
        statusCode,
        statusId: response.id,
        technicalStatus: response.attributes.technicalStatus,
      };
    } catch (error) {
      const errorMessage = error.response?.data?.errors?.[0]?.detail || error.message;
      return {
        success: false,
        statusCode,
        error: errorMessage,
      };
    }
  }

  getRandomFinalStatus() {
    const { ACCEPTED, REJECTED } = CONFIG.businessStatus.codes;
    return randomChoice([ACCEPTED, REJECTED]);
  }
}

// ============================================================================
// REPORT GENERATOR
// ============================================================================

class InvoiceReportGenerator {
  constructor(apiService) {
    this.api = apiService;
    this.statusManager = new BusinessStatusManager(apiService);
    this.processResults = new Map();
    this.fileWriter = new ReportFileWriter(CONFIG.settings.outputDir);
  }

  async generateReport() {
    const matches = await this.fetchAndMatchDocuments();
    if (!matches.length) return;

    Logger.header('STAP 1: ANALYSE');
    const analysis = await this.analyzeAllDocuments(matches);
    this.printAnalysis(analysis);

    // Splits documenten op basis van datum (28 nov of later vs eerder)
    const cutoffDate = new Date('2025-11-28T00:00:00Z');
    const { nov28AndLater, beforeNov28 } = await this.splitByDate(matches, cutoffDate);

    // Voor documenten van 28 nov en later: ga direct naar final status
    if (nov28AndLater.length > 0) {
      Logger.header('STAP 2: ACCEPTED/REJECTED VERSTUREN (28 NOV+)');
      Logger.info(`${nov28AndLater.length} document(en) van 28 november of later gevonden.`);
      
      const nov28Analysis = analysis.filter((a) => 
        nov28AndLater.some(m => m.inbound.id === a.documentId)
      );
      const needsFinalNov28 = nov28Analysis.filter((a) => a.needsFinalStatus);

      if (needsFinalNov28.length > 0) {
        const successCount = await this.sendFinalStatuses(needsFinalNov28);
        await this.handleWaitTime(successCount, CONFIG.settings.finalStatusWaitTime, 'final status');
      } else {
        Logger.info('Alle documenten van 28 nov+ hebben al een final status. Overslaan.');
      }
    }
 
    if (beforeNov28.length > 0) {
      Logger.header('STAP 2: ACCEPTED/REJECTED VERSTUREN (VOOR 28 NOV)');
      const beforeNov28Analysis = analysis.filter((a) => 
        beforeNov28.some(m => m.inbound.id === a.documentId)
      );
      const needsFinal = beforeNov28Analysis.filter((a) => a.needsFinalStatus);

      if (needsFinal.length > 0) {
        const successCount = await this.sendFinalStatuses(needsFinal);
        await this.handleWaitTime(successCount, CONFIG.settings.finalStatusWaitTime, 'final status');
      } else {
        Logger.info('Alle documenten hebben al een final status. Overslaan.');
      }
    }

    Logger.header('EINDRESULTATEN');
    await this.printFinalResults(matches);

    Logger.header('RAPPORT OPSLAAN');
    await this.saveReportToFile(matches);
  }

  async fetchAndMatchDocuments() {
    Logger.info('Inbound documenten ophalen...');
    const inboundDocs = await this.api.fetchInboundDocuments(CONFIG.suppliers.inbound.id);

    if (!inboundDocs.length) {
      Logger.error('Geen inkomende facturen gevonden.');
      return [];
    }
    Logger.success(`${inboundDocs.length} inbound document(en) gevonden.`);

    Logger.info('Outbound documenten ophalen...');
    const outboundMap = await this.buildOutboundMap();
    const matches = this.findMatches(inboundDocs, outboundMap);

    if (!matches.length) {
      Logger.error('Geen matches gevonden.');
      return [];
    }
    Logger.success(`${matches.length} match(es) gevonden.`);

    return matches;
  }

  async analyzeAllDocuments(matches) {
    const results = [];

    for (const match of matches) {
      const analysis = await this.statusManager.analyzeDocument(match.inbound.id);
      const outboundBusinessState = match.outbound.attributes.businessStatus || null;

      // Inbound statuses zijn leidend - outbound check alleen voor informatieve doeleinden
      results.push({
        documentId: match.inbound.id,
        transmissionId: match.transmissionId,
        match,
        ...analysis,
        outboundBusinessState,
      });
    }

    return results;
  }

  printAnalysis(analysis) {
    console.log('Huidige status overzicht:');
    Logger.separator();

    for (const item of analysis) {
      const inboundStatus =
        item.existingCodes.length > 0 ? item.existingCodes.join(', ') : 'geen';
      const outboundStatus = item.outboundBusinessState || '-';

      let action = '';
      if (item.isComplete) {
        action = '→ Compleet (geen actie nodig)';
      } else if (item.needsFinalStatus) {
        action = '→ Needs: final status';
      }

      console.log(`  ${item.documentId}`);
      console.log(`    Inbound Status: [${inboundStatus}]`);
      console.log(`    Outbound Business State: ${outboundStatus}`);
      console.log(`    ${action}`);
    }

    Logger.separator();
  }

  async sendStatuses(documents, phase, getStatusCode, getLabel) {
    console.log(getLabel());
    Logger.separator();

    let successCount = 0;

    for (const doc of documents) {
      const statusCode = getStatusCode();
      const result = await this.statusManager.sendStatus(doc.documentId, statusCode);
      this.storeResult(doc.documentId, phase, result);

      if (result.success) {
        successCount++;
        const emoji = statusCode === 'accepted' ? '👍' : statusCode === 'rejected' ? '👎' : '✅';
        console.log(
          `  ${emoji} ${doc.documentId} → ${statusCode} (technical: ${result.technicalStatus})`
        );
      } else {
        console.log(`  ❌ ${doc.documentId} → FOUT: ${result.error}`);
      }
    }

    Logger.separator();
    return successCount;
  }

  async sendFinalStatuses(documents) {
    return this.sendStatuses(
      documents,
      'final',
      () => this.statusManager.getRandomFinalStatus(),
      () => 'Final statuses versturen (random accepted/rejected):'
    );
  }

  storeResult(documentId, phase, result) {
    if (!this.processResults.has(documentId)) {
      this.processResults.set(documentId, {});
    }
    this.processResults.get(documentId)[phase] = result;
  }

  async handleWaitTime(successCount, waitTimeMs, label) {
    if (successCount > 0) {
      Logger.blank();
      Logger.info(`Wachten ${waitTimeMs / 1000} seconden na ${label}...`);
      await this.countdown(waitTimeMs);
    } else {
      Logger.blank();
      Logger.info(`Geen ${label} succesvol verstuurd. Wachttijd overgeslagen.`);
    }
  }

  async countdown(totalMs, intervalMs = 5000) {
    let remaining = totalMs;
    while (remaining > 0) {
      process.stdout.write(`\r   ⏳ Nog ${remaining / 1000} seconden...   `);
      await sleep(intervalMs);
      remaining -= intervalMs;
    }
    process.stdout.write('\r   ✅ Wachttijd voltooid.           \n');
  }

  async buildOutboundMap() {
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - CONFIG.settings.lookbackDays);

    const outboundDocs = await this.api.fetchOutboundDocuments(
      CONFIG.suppliers.outbound.id,
      fromDate
    );

    return new Map(
      outboundDocs
        .filter((doc) => doc.attributes.transmissionId)
        .map((doc) => [doc.attributes.transmissionId, doc])
    );
  }

  findMatches(inboundDocs, outboundMap) {
    return inboundDocs
      .filter((doc) => outboundMap.has(doc.attributes.transmissionId))
      .map((inDoc) => ({
        inbound: inDoc,
        outbound: outboundMap.get(inDoc.attributes.transmissionId),
        transmissionId: inDoc.attributes.transmissionId,
      }));
  }

  async splitByDate(matches, cutoffDate) {
    const nov28AndLater = [];
    const beforeNov28 = [];

    for (const match of matches) {
      const xmlDetails = await this.fetchXmlDetailsSafe(match.inbound.id);
      // Gebruik issueDate uit XML als beschikbaar, anders createdAt van inbound document
      const invoiceDate = xmlDetails.issueDate || new Date(match.inbound.attributes.createdAt);
      
      // Vergelijk alleen de datum (zonder tijd)
      const invoiceDateOnly = new Date(invoiceDate.getFullYear(), invoiceDate.getMonth(), invoiceDate.getDate());
      const cutoffDateOnly = new Date(cutoffDate.getFullYear(), cutoffDate.getMonth(), cutoffDate.getDate());

      if (invoiceDateOnly >= cutoffDateOnly) {
        nov28AndLater.push(match);
      } else {
        beforeNov28.push(match);
      }
    }

    return { nov28AndLater, beforeNov28 };
  }

  async printFinalResults(matches) {
    const sortedMatches = await this.sortMatchesByInvoiceNumber(matches);
    const freshOutboundMap = await this.buildOutboundMap();

    for (const match of sortedMatches) {
      const freshOutbound = freshOutboundMap.get(match.transmissionId) || match.outbound;
      const processResult = this.processResults.get(match.inbound.id) || {};
      const freshInboundStatuses = await this.fetchBusinessStatusSafe(match.inbound.id);
      const freshInboundStatus = StatusResolver.getLatestStatus(freshInboundStatuses);

      await this.printMatch(
        { ...match, outbound: freshOutbound },
        processResult,
        freshInboundStatus
      );
    }
  }

  async printMatch({ inbound, outbound, transmissionId }, processResult, inboundStatus = null) {
    const [xmlDetails, statuses] = await Promise.all([
      this.fetchXmlDetailsSafe(inbound.id),
      inboundStatus ? Promise.resolve([]) : this.fetchBusinessStatusSafe(inbound.id),
    ]);

    const status = inboundStatus || StatusResolver.getLatestStatus(statuses);

    this.printInvoiceHeader(xmlDetails);
    this.printOutboundSection(outbound);
    this.printTransmissionSection(transmissionId);
    this.printInboundSection(inbound, status);
    this.printProcessSummary(processResult);

    Logger.separator();
    Logger.blank();
  }

  async saveReportToFile(matches) {
    this.fileWriter.init();

    const sortedMatches = await this.sortMatchesByInvoiceNumber(matches);
    const freshOutboundMap = await this.buildOutboundMap();

    for (const match of sortedMatches) {
      const freshOutbound = freshOutboundMap.get(match.transmissionId) || match.outbound;
      const processResult = this.processResults.get(match.inbound.id) || {};

      const [xmlDetails, inboundStatuses] = await Promise.all([
        this.fetchXmlDetailsSafe(match.inbound.id),
        this.fetchBusinessStatusSafe(match.inbound.id),
      ]);

      const inboundStatus = StatusResolver.getLatestStatus(inboundStatuses);

      this.writeInvoiceToFile(
        { ...match, outbound: freshOutbound },
        xmlDetails,
        inboundStatus,
        processResult
      );
    }

    const filename = this.fileWriter.save();
    Logger.success(`Rapport opgeslagen: ${filename}`);
  }

  writeInvoiceToFile({ inbound, outbound, transmissionId }, xmlDetails, inboundStatus, processResult) {
    const fw = this.fileWriter;

    fw.addLine(`Factuurnummer (BIS 3.0)         : ${xmlDetails.invoiceNumber}`);
    fw.addLine(`Betreft (BIS 3.0)               : ${xmlDetails.description}`);
    fw.addBlank();

    fw.addLine(`Outbound Supplier name         : ${CONFIG.suppliers.outbound.name}`);
    fw.addLine(`Outbound Supplier ID           : ${CONFIG.suppliers.outbound.id}`);
    fw.addLine(`Outbound FactuurID             : ${outbound.id}`);
    fw.addLine(`Outbound Created DateTime      : ${outbound.attributes.createdAt}`);
    fw.addLine(`Outbound technical-state       : ${outbound.attributes.technicalStatus || '-'}`);
    fw.addLine(`Outbound business-state        : ${outbound.attributes.businessStatus || '-'}`);
    fw.addBlank();

    fw.addLine(`Transmission FactuurID         : ${transmissionId}`);
    fw.addBlank();

    fw.addLine(`Inbound Supplier name          : ${CONFIG.suppliers.inbound.name}`);
    fw.addLine(`Inbound Supplier ID            : ${CONFIG.suppliers.inbound.id}`);
    fw.addLine(`Inbound FactuurID              : ${inbound.id}`);
    fw.addLine(`Inbound Created DateTime       : ${inbound.attributes.createdAt}`);
    fw.addLine(`IMR technical-state            : ${inboundStatus.technicalStatus}`);
    fw.addLine(`IMR business-state             : ${inboundStatus.code}`);

    // Acties toevoegen aan bestand
    const actions = this.formatActions(processResult);
    if (actions.length > 0) {
      fw.addBlank();
      fw.addLine(`Acties deze run                : ${actions.join(' → ')}`);
    }

    fw.addSeparator();
    fw.addBlank();
  }

  formatActions(processResult) {
    const actions = [];

    if (processResult.final) {
      const fin = processResult.final;
      const emoji = fin.statusCode === 'accepted' ? '👍' : '👎';
      actions.push(fin.success ? `${fin.statusCode} ${emoji}` : `${fin.statusCode} ❌ (${fin.error})`);
    }

    return actions;
  }

  async fetchXmlDetailsSafe(docId) {
    try {
      const xml = await this.api.fetchDocumentXml(docId);
      return XmlParser.parseInvoiceDetails(xml);
    } catch {
      return { invoiceNumber: 'Error', description: 'Error', issueDate: null };
    }
  }

  async sortMatchesByInvoiceNumber(matches) {
    const matchesWithNumbers = await Promise.all(
      matches.map(async (match) => ({
        match,
        invoiceNumber: (await this.fetchXmlDetailsSafe(match.inbound.id)).invoiceNumber,
      }))
    );

    matchesWithNumbers.sort((a, b) => {
      const numA = parseInt(a.invoiceNumber, 10);
      const numB = parseInt(b.invoiceNumber, 10);
      return !isNaN(numA) && !isNaN(numB)
        ? numA - numB
        : a.invoiceNumber.localeCompare(b.invoiceNumber);
    });

    return matchesWithNumbers.map((item) => item.match);
  }

  async fetchBusinessStatusSafe(docId) {
    try {
      return await this.api.fetchInboundBusinessStatuses(docId);
    } catch {
      return [];
    }
  }

  printInvoiceHeader({ invoiceNumber, description }) {
    console.log(`Factuurnummer (BIS 3.0)         : ${invoiceNumber}`);
    console.log(`Betreft (BIS 3.0)               : ${description}`);
    Logger.blank();
  }

  printOutboundSection(doc) {
    const { outbound } = CONFIG.suppliers;
    const { id, attributes } = doc;

    console.log(`Outbound Supplier name         : ${outbound.name}`);
    console.log(`Outbound Supplier ID           : ${outbound.id}`);
    console.log(`Outbound FactuurID             : ${id}`);
    console.log(`Outbound Created DateTime      : ${attributes.createdAt}`);
    console.log(`Outbound technical-state       : ${attributes.technicalStatus || '-'}`);
    console.log(`Outbound business-state        : ${attributes.businessStatus || '-'}`);
    Logger.blank();
  }

  printTransmissionSection(transmissionId) {
    console.log(`Transmission FactuurID         : ${transmissionId}`);
    Logger.blank();
  }

  printInboundSection(doc, status) {
    const { inbound } = CONFIG.suppliers;
    const { id, attributes } = doc;

    console.log(`Inbound Supplier name          : ${inbound.name}`);
    console.log(`Inbound Supplier ID            : ${inbound.id}`);
    console.log(`Inbound FactuurID              : ${id}`);
    console.log(`Inbound Created DateTime       : ${attributes.createdAt}`);
    console.log(`IMR technical-state            : ${status.technicalStatus}`);
    console.log(`IMR business-state             : ${status.code}`);
  }

  printProcessSummary(processResult) {
    const actions = this.formatActions(processResult);

    if (actions.length > 0) {
      Logger.blank();
      console.log(`Acties deze run                : ${actions.join(' → ')}`);
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  try {
    Logger.info('Authenticeren...');

    const httpClient = createHttpClient();
    const apiService = new PeppolApiService(httpClient);

    await apiService.authenticate();
    Logger.success('Token verkregen.');

    const reportGenerator = new InvoiceReportGenerator(apiService);
    await reportGenerator.generateReport();
  } catch (error) {
    Logger.error(`Applicatiefout: ${error.message}`);
    process.exit(1);
  }
}

main();