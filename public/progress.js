// Shared between server.js (via require) and the browser (via <script src="/progress.js">).
// No Node-only APIs are used below so the same file works unmodified in both places.

const FILE_FIELDS = [
  { name: "driversLicence", label: "Valid Driver's Licence", maxCount: 2 },
  { name: "passport", label: "Valid Passport", maxCount: 2 },
  { name: "payslips", label: "Most recent 2 consecutive payslips (if PAYG)", maxCount: 4 },
  {
    name: "incomeProof",
    label: "Latest 3-month bank statement (salary credits) or latest FY income statement (if PAYG)",
    maxCount: 6,
  },
  {
    name: "homeLoanStatements",
    label: "Latest 6-month home loan statement(s) (for any mortgaged property)",
    maxCount: 6,
  },
  {
    name: "rentalIncomeStatements",
    label: "Latest rental income statement(s) (for investment properties)",
    maxCount: 6,
  },
  {
    name: "councilRatesNotices",
    label: "Most recent Council Rates Notice + payment proof (for owned properties)",
    maxCount: 6,
  },
  {
    name: "taxReturn",
    label: "Most recent Individual Tax Return (ITR) FY25 or FY26 (PAYG or self-employed)",
    maxCount: 4,
  },
  {
    name: "companyTaxReturn",
    label: "Most recent Company Tax Return (CTR) FY25 or FY26 (if self-employed)",
    maxCount: 4,
  },
  {
    name: "liabilityStatements",
    label: "Latest 1-month statement(s) for liabilities (credit cards, loans, etc.)",
    maxCount: 10,
  },
  {
    name: "nameChangeCertificate",
    label: "Change of Name or Marriage Certificate (if applicable)",
    maxCount: 2,
  },
];

const REQUIRED_FILE_FIELDS = ["driversLicence", "passport"];

function isFilled(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

// Every document type is always requested — the company would rather a
// client see (and skip) an irrelevant one than have this inference silently
// omit a document they actually needed. clientInfo is kept as a parameter
// so callers/signature stay stable even though it's unused now.
function docApplicability(clientInfo) {
  return FILE_FIELDS;
}

function fieldHasUpload(files, fieldName) {
  const entry = files && files[fieldName];
  if (!entry) return false;
  return Array.isArray(entry) ? entry.length > 0 : true;
}

function computeDocProgress(clientInfo, files) {
  const applicable = docApplicability(clientInfo || {});
  const uploaded = applicable.filter((f) => fieldHasUpload(files || {}, f.name));
  const total = applicable.length;
  const percent = total ? Math.round((uploaded.length / total) * 100) : 0;
  return {
    applicable: applicable.map((f) => f.name),
    uploaded: uploaded.map((f) => f.name),
    total,
    filled: uploaded.length,
    percent,
  };
}

// --- rough "how much of the fact-find has this client filled in" ---------
// Walks a fixed checklist of field values, following the same conditional
// visibility rules the form itself uses (e.g. self-employed fields only
// count when self-employed), and reports filled/total.
// Only free-input fields (text/number/date/checkbox-group) belong in this
// checklist. <select> fields are deliberately excluded — every select on the
// form ships with a real option (not a blank placeholder) pre-selected, so
// its value is never actually "empty" and would always count as filled.
function personSectionItems(person) {
  const personal = (person && person.personal) || {};
  const address = (person && person.address) || {};
  const employment = (person && person.employment) || {};
  const additionalIncome = (person && person.additionalIncome) || {};
  const items = [];

  items.push(personal.firstName, personal.lastName || personal.surname, personal.email, personal.mobilePhone);
  if (personal.hasMiddleName === "Yes") items.push(personal.middleName);
  if (personal.dependants === "Yes") items.push(personal.dependantsCount, personal.dependantsAges);

  items.push(address.residentialAddress, address.addressStartDate);
  if (address.postalSameAsResidential === "No") items.push(address.postalAddress);
  if (address.afterSettlementAddressKnown === "Yes") items.push(address.afterSettlementAddress);

  if (employment.currentlyEmployed === "Yes") {
    if (employment.employmentType === "PAYG" || employment.employmentType === "Contractor") {
      items.push(employment.employerName, employment.employmentStartDate, employment.occupation, employment.grossIncome, employment.employerAddress);
    }
    if (employment.employmentType === "Self-employed") {
      const se = employment.selfEmployed || {};
      items.push(se.businessName, se.occupation, se.businessStartDate, se.natureOfBusiness, se.abnAcn);
    }
  }

  if (additionalIncome.fromEmployment === "Yes") {
    items.push(additionalIncome.sources && additionalIncome.sources.length ? "x" : "");
  }

  return items;
}

function computeFormProgress(clientInfo) {
  const info = clientInfo || {};
  let items = [];

  items = items.concat(
    personSectionItems({
      personal: info.personal,
      address: info.address,
      employment: info.employment,
      additionalIncome: info.additionalIncome,
    })
  );

  if (info.applicants === "Me and someone else" && info.secondApplicant) {
    items = items.concat(personSectionItems(info.secondApplicant));
  }

  const re = info.realEstate || {};
  const reh = re.existingHome || {};
  items.push(reh.estimatedValue, reh.lender, reh.amountOwing);
  if (re.hasInvestmentProperties === "Yes") {
    items.push(re.investmentProperties && re.investmentProperties.length ? "x" : "");
  }

  const assets = info.assets || {};
  items.push(assets.owned && assets.owned.length ? "x" : "");

  const liabilities = info.liabilities || {};
  items.push(liabilities.types && liabilities.types.length ? "x" : "");

  const oe = info.ongoingExpenses || {};
  items.push(oe.types && oe.types.length ? "x" : "");

  const total = items.length;
  const filled = items.filter(isFilled).length;
  const percent = total ? Math.round((filled / total) * 100) : 0;

  return { filled, total, percent };
}

const api = {
  FILE_FIELDS,
  REQUIRED_FILE_FIELDS,
  docApplicability,
  computeDocProgress,
  computeFormProgress,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
} else {
  window.DocklioProgress = api;
}
