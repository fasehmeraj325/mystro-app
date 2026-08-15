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

// Every document type is requested by default — the company would rather a
// client see (and skip) an irrelevant one than have this inference silently
// omit a document they actually needed. A company can turn individual
// non-essential types off in Settings (documentConfig), which is the only
// thing that removes a field from this list; driversLicence/passport can
// never be turned off since some form of ID is always required.
function docApplicability(clientInfo, documentConfig) {
  const config = (documentConfig && typeof documentConfig === "object") ? documentConfig : {};
  return FILE_FIELDS.filter((f) => REQUIRED_FILE_FIELDS.includes(f.name) || config[f.name] !== false);
}

function fieldHasUpload(files, fieldName) {
  const entry = files && files[fieldName];
  if (!entry) return false;
  return Array.isArray(entry) ? entry.length > 0 : true;
}

function computeDocProgress(clientInfo, files, documentConfig) {
  const applicable = docApplicability(clientInfo || {}, documentConfig);
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
// A company can turn off a handful of fully optional fact-find sections
// (formConfig.sections) — everything else (identity/address/employment) is
// core to any mortgage application and can't be disabled. Absent/anything
// but `false` means the section is on, matching documentConfig's convention.
function isFormSectionEnabled(formConfig, section) {
  const sections = (formConfig && formConfig.sections) || {};
  return sections[section] !== false;
}

function personSectionItems(person, includeAdditionalIncome) {
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

  if (includeAdditionalIncome && additionalIncome.fromEmployment === "Yes") {
    items.push(additionalIncome.sources && additionalIncome.sources.length ? "x" : "");
  }

  return items;
}

function computeFormProgress(clientInfo, formConfig) {
  const info = clientInfo || {};
  const includeAdditionalIncome = isFormSectionEnabled(formConfig, "additionalIncome");
  let items = [];

  items = items.concat(
    personSectionItems(
      { personal: info.personal, address: info.address, employment: info.employment, additionalIncome: info.additionalIncome },
      includeAdditionalIncome
    )
  );

  if (info.applicants === "Me and someone else" && info.secondApplicant) {
    items = items.concat(personSectionItems(info.secondApplicant, includeAdditionalIncome));
  }

  if (isFormSectionEnabled(formConfig, "realEstate")) {
    const re = info.realEstate || {};
    const reh = re.existingHome || {};
    items.push(reh.estimatedValue, reh.lender, reh.amountOwing);
    if (re.hasInvestmentProperties === "Yes") {
      items.push(re.investmentProperties && re.investmentProperties.length ? "x" : "");
    }
  }

  if (isFormSectionEnabled(formConfig, "assets")) {
    const assets = info.assets || {};
    items.push(assets.owned && assets.owned.length ? "x" : "");
  }

  if (isFormSectionEnabled(formConfig, "liabilities")) {
    const liabilities = info.liabilities || {};
    items.push(liabilities.types && liabilities.types.length ? "x" : "");
  }

  if (isFormSectionEnabled(formConfig, "ongoingExpenses")) {
    const oe = info.ongoingExpenses || {};
    items.push(oe.types && oe.types.length ? "x" : "");
  }

  const total = items.length;
  const filled = items.filter(isFilled).length;
  const percent = total ? Math.round((filled / total) * 100) : 0;

  return { filled, total, percent };
}

const OPTIONAL_FORM_SECTIONS = [
  { name: "additionalIncome", label: "Additional income" },
  { name: "realEstate", label: "Real estate assets" },
  { name: "assets", label: "Assets" },
  { name: "liabilities", label: "Liabilities" },
  { name: "ongoingExpenses", label: "Ongoing expenses" },
];

const api = {
  FILE_FIELDS,
  REQUIRED_FILE_FIELDS,
  OPTIONAL_FORM_SECTIONS,
  isFormSectionEnabled,
  docApplicability,
  computeDocProgress,
  computeFormProgress,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
} else {
  window.DocklioProgress = api;
}
