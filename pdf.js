const PDFDocument = require("pdfkit");

const BRAND = "#3a3aff";
const INK = "#1a1d29";
const MUTED = "#6b7080";
const LINE = "#e4e6ec";

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function fmtMoney(v) {
  if (v === undefined || v === null || v === "") return "—";
  const n = Number(v);
  return isNaN(n) ? String(v) : "$" + n.toLocaleString();
}

function fmtVal(v) {
  if (v === undefined || v === null || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  return String(v);
}

function leftX(doc) {
  return doc.page.margins.left;
}

function rightEdge(doc) {
  return doc.page.width - doc.page.margins.right;
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function sectionHeading(doc, title) {
  ensureSpace(doc, 60);
  doc.y += 12;
  const x = leftX(doc);
  doc
    .fontSize(12)
    .fillColor(BRAND)
    .font("Helvetica-Bold")
    .text(title.toUpperCase(), x, doc.y, { characterSpacing: 0.5 });
  doc
    .moveTo(x, doc.y + 2)
    .lineTo(rightEdge(doc), doc.y + 2)
    .strokeColor(LINE)
    .lineWidth(1)
    .stroke();
  doc.y += 14;
}

function subHeading(doc, title) {
  ensureSpace(doc, 40);
  doc.y += 8;
  doc.fontSize(11).fillColor(INK).font("Helvetica-Bold").text(title, leftX(doc), doc.y);
  doc.y += 4;
}

function row(doc, label, value) {
  const x = leftX(doc);
  const labelWidth = 190;
  const valueX = x + labelWidth + 10;
  const valueWidth = rightEdge(doc) - valueX;
  const text = fmtVal(value);

  doc.fontSize(10).font("Helvetica");
  const labelHeight = doc.heightOfString(label, { width: labelWidth });
  doc.fontSize(10).font("Helvetica-Bold");
  const valueHeight = doc.heightOfString(text, { width: valueWidth });
  const rowHeight = Math.max(labelHeight, valueHeight);

  ensureSpace(doc, rowHeight + 8);
  const startY = doc.y;

  doc.fontSize(10).font("Helvetica").fillColor(MUTED).text(label, x, startY, { width: labelWidth });
  doc.fontSize(10).font("Helvetica-Bold").fillColor(INK).text(text, valueX, startY, { width: valueWidth });

  doc.x = x;
  doc.y = startY + rowHeight + 8;
}

function moneyRow(doc, label, value) {
  row(doc, label, value === undefined || value === null || value === "" ? "" : fmtMoney(value));
}

function rows(doc, pairs) {
  pairs.forEach(([label, value]) => row(doc, label, value));
}

function buildClientPdf(res, submission) {
  const info = submission.clientInfo || {};
  const p = info.personal || {};
  const a = info.address || {};
  const e = info.employment || {};
  const ai = info.additionalIncome || {};
  const re = info.realEstate || {};
  const reh = re.existingHome || {};
  const assets = info.assets || {};
  const liabilities = info.liabilities || {};

  const doc = new PDFDocument({ size: "A4", margin: 50 });

  res.setHeader("Content-Type", "application/pdf");
  const safeName = (submission.fullName || "client").replace(/[^a-zA-Z0-9._-]/g, "_");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}-client-form.pdf"`);
  doc.pipe(res);

  doc.fontSize(20).font("Helvetica-Bold").fillColor(INK).text("Client Information Form");
  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor(MUTED)
    .text(`${submission.fullName || "—"}  ·  Submitted ${fmtDate(submission.submittedAt)}  ·  Status: ${submission.status}`);

  const secondApplicant = info.secondApplicant || null;
  const sp2 = secondApplicant ? secondApplicant.personal || {} : {};

  sectionHeading(doc, "Contact & Applicants");
  rows(doc, [
    ["Full name", submission.fullName],
    ["Email", submission.email],
    ["Phone", submission.phone],
    ["Applicants", info.applicants],
  ]);
  if (secondApplicant) {
    rows(doc, [
      ["Second applicant name", [sp2.firstName, sp2.lastName || sp2.surname].filter(Boolean).join(" ")],
      ["Second applicant email", sp2.email],
      ["Second applicant phone", sp2.mobilePhone],
    ]);
  }

  sectionHeading(doc, "Personal Details");
  rows(doc, [
    ["Title", p.title],
    ["First name", p.firstName],
    ["Surname", p.surname],
    ["Last name", p.lastName],
    ["Has middle name", p.hasMiddleName],
    ["Middle name", p.middleName],
    ["Email address", p.email],
    ["Mobile phone", p.mobilePhone],
    ["Australian citizen", p.australianCitizen],
    ["Australian driving licence", p.drivingLicense],
    ["Marital status", p.maritalStatus],
    ["Dependants", p.dependants],
    ["Number of dependants", p.dependantsCount],
    ["Dependants age(s)", p.dependantsAges],
  ]);

  sectionHeading(doc, "Address");
  rows(doc, [
    ["Residential address", a.residentialAddress],
    ["Residential status", a.residentialStatus],
    ["Address start date", a.addressStartDate],
    ["Postal same as residential", a.postalSameAsResidential],
    ["Postal address", a.postalAddress],
    ["Previous address", a.previousAddress],
    ["Previous address start date", a.previousAddressStartDate],
    ["Previous address stop date", a.previousAddressStopDate],
    ["After-settlement address known", a.afterSettlementAddressKnown],
    ["After-settlement address", a.afterSettlementAddress],
  ]);

  sectionHeading(doc, "Employment & Income");
  rows(doc, [
    ["Currently employed", e.currentlyEmployed],
    ["Current employment type", e.employmentType],
    ["Second job", e.secondJob],
    ["Employer's business name", e.employerName],
    ["Current employment status", e.employmentStatus],
    ["Employment start date", e.employmentStartDate],
    ["Occupation", e.occupation],
    ["Income frequency", e.incomeFrequency],
  ]);
  moneyRow(doc, "Pre-tax income (gross)", e.grossIncome);
  rows(doc, [
    ["Employer's address", e.employerAddress],
    ["Employer contact name", e.employerContactName],
    ["Employer number", e.employerNumber],
    ["Previous employer's business name", e.previousEmployerName],
    ["Previous occupation", e.previousOccupation],
    ["Previous employment start date", e.previousEmploymentStartDate],
    ["Previous employment stop date", e.previousEmploymentStopDate],
  ]);

  const se = e.selfEmployed || {};
  if (e.employmentType === "Self-employed" && Object.keys(se).length) {
    sectionHeading(doc, "Self Employed");
    rows(doc, [
      ["Business name", se.businessName],
      ["Occupation", se.occupation],
      ["Company type", se.companyType],
      ["Business start date", se.businessStartDate],
      ["Current employment status", se.currentEmploymentStatus],
      ["Nature of business", se.natureOfBusiness],
      ["ABN/ACN", se.abnAcn],
    ]);
  }

  sectionHeading(doc, "Additional Income");
  rows(doc, [
    ["From employment", ai.fromEmployment],
    ["Source(s)", ai.sources],
    ["From government", ai.fromGovernment],
    ["From investments", ai.fromInvestments],
  ]);
  const sourceDetails = ai.sourceDetails || {};
  Object.keys(sourceDetails).forEach((source) => {
    const d = sourceDetails[source] || {};
    subHeading(doc, source);
    rows(doc, [["Frequency", d.frequency]]);
    moneyRow(doc, "Monthly amount", d.monthlyAmount);
  });

  if (secondApplicant) {
    const a2 = secondApplicant.address || {};
    const e2 = secondApplicant.employment || {};
    const se2 = e2.selfEmployed || {};
    const ai2 = secondApplicant.additionalIncome || {};

    sectionHeading(doc, "Second Applicant — Personal Details");
    rows(doc, [
      ["Title", sp2.title], ["First name", sp2.firstName], ["Surname", sp2.surname],
      ["Last name", sp2.lastName],
      ["Has middle name", sp2.hasMiddleName], ["Middle name", sp2.middleName],
      ["Email address", sp2.email], ["Mobile phone", sp2.mobilePhone],
      ["Australian citizen", sp2.australianCitizen], ["Australian driving licence", sp2.drivingLicense],
      ["Marital status", sp2.maritalStatus], ["Dependants", sp2.dependants],
      ["Number of dependants", sp2.dependantsCount], ["Dependants age(s)", sp2.dependantsAges],
    ]);

    sectionHeading(doc, "Second Applicant — Address");
    rows(doc, [
      ["Residential address", a2.residentialAddress], ["Residential status", a2.residentialStatus],
      ["Address start date", a2.addressStartDate],
      ["Postal same as residential", a2.postalSameAsResidential], ["Postal address", a2.postalAddress],
      ["Previous address", a2.previousAddress],
      ["Previous address start date", a2.previousAddressStartDate],
      ["Previous address stop date", a2.previousAddressStopDate],
      ["After-settlement address known", a2.afterSettlementAddressKnown],
      ["After-settlement address", a2.afterSettlementAddress],
    ]);

    sectionHeading(doc, "Second Applicant — Employment & Income");
    rows(doc, [
      ["Currently employed", e2.currentlyEmployed], ["Current employment type", e2.employmentType],
      ["Second job", e2.secondJob], ["Employer's business name", e2.employerName],
      ["Current employment status", e2.employmentStatus], ["Employment start date", e2.employmentStartDate],
      ["Occupation", e2.occupation], ["Income frequency", e2.incomeFrequency],
    ]);
    moneyRow(doc, "Pre-tax income (gross)", e2.grossIncome);
    rows(doc, [
      ["Employer's address", e2.employerAddress], ["Employer contact name", e2.employerContactName],
      ["Employer number", e2.employerNumber],
      ["Previous employer's business name", e2.previousEmployerName], ["Previous occupation", e2.previousOccupation],
      ["Previous employment start date", e2.previousEmploymentStartDate], ["Previous employment stop date", e2.previousEmploymentStopDate],
    ]);
    if (e2.employmentType === "Self-employed" && Object.keys(se2).length) {
      subHeading(doc, "Self Employed");
      rows(doc, [
        ["Business name", se2.businessName], ["Occupation", se2.occupation],
        ["Company type", se2.companyType], ["Business start date", se2.businessStartDate],
        ["Current employment status", se2.currentEmploymentStatus],
        ["Nature of business", se2.natureOfBusiness], ["ABN/ACN", se2.abnAcn],
      ]);
    }

    sectionHeading(doc, "Second Applicant — Additional Income");
    rows(doc, [
      ["From employment", ai2.fromEmployment], ["Source(s)", ai2.sources],
      ["From government", ai2.fromGovernment], ["From investments", ai2.fromInvestments],
    ]);
    const sourceDetails2 = ai2.sourceDetails || {};
    Object.keys(sourceDetails2).forEach((source) => {
      const d = sourceDetails2[source] || {};
      subHeading(doc, source);
      rows(doc, [["Frequency", d.frequency]]);
      moneyRow(doc, "Monthly amount", d.monthlyAmount);
    });
  }

  sectionHeading(doc, "Real Estate Assets");
  row(doc, "Owns investment properties", re.hasInvestmentProperties);
  subHeading(doc, "Existing home");
  moneyRow(doc, "Estimated value", reh.estimatedValue);
  row(doc, "Who owns this", reh.owner);
  row(doc, "Lender", reh.lender);
  moneyRow(doc, "Amount owing", reh.amountOwing);
  moneyRow(doc, "Original loan amount", reh.originalLoanAmount);
  rows(doc, [["Interest rate known", reh.interestRateKnown]]);
  if (reh.interestRateKnown === "Yes") row(doc, "Interest rate", reh.interestRate ? `${reh.interestRate}%` : "");
  rows(doc, [["Fixed rate", reh.isFixed]]);
  moneyRow(doc, "Monthly repayment amount", reh.monthlyRepayment);
  row(doc, "Is refinance", reh.isRefinance);

  const investmentProperties = re.investmentProperties || [];
  investmentProperties.forEach((prop, i) => {
    subHeading(doc, `Investment property ${i + 1}`);
    row(doc, "Address", prop.address);
    moneyRow(doc, "Estimated value", prop.estimatedValue);
    row(doc, "Who owns this", prop.owner);
    moneyRow(doc, "Rent income", prop.rentIncome);
    row(doc, "Is financed", prop.isFinanced);
    row(doc, "Lender", prop.lender);
    moneyRow(doc, "Amount owing", prop.amountOwing);
    moneyRow(doc, "Original loan amount", prop.originalLoanAmount);
    row(doc, "Interest rate known", prop.interestRateKnown);
    if (prop.interestRateKnown === "Yes") row(doc, "Interest rate", prop.interestRate ? `${prop.interestRate}%` : "");
    row(doc, "Fixed rate", prop.isFixed);
    moneyRow(doc, "Monthly repayment amount", prop.monthlyRepayment);
    row(doc, "Is refinance", prop.isRefinance);
  });

  sectionHeading(doc, "Assets");
  row(doc, "Assets owned", assets.owned);
  const assetDetails = assets.details || {};
  Object.keys(assetDetails).forEach((type) => {
    const d = assetDetails[type] || {};
    subHeading(doc, type);
    row(doc, "Description", d.description);
    moneyRow(doc, "Estimated value", d.estimatedValue);
    row(doc, "Who owns this", d.owner);
  });
  const savingsAccounts = assets.savingsAccounts || [];
  savingsAccounts.forEach((s, i) => {
    subHeading(doc, `Savings account ${i + 1}`);
    moneyRow(doc, "Savings amount", s.savingsAmount);
    row(doc, "Financial institution", s.financialInstitution);
    row(doc, "Who owns this", s.owner);
  });

  sectionHeading(doc, "Liabilities");
  row(doc, "Liability types", liabilities.types);

  const personalLoans = liabilities.personalLoans || [];
  personalLoans.forEach((l, i) => {
    subHeading(doc, `Personal loan ${i + 1}`);
    row(doc, "Lender", l.lender);
    row(doc, "Who owns this", l.owner);
    moneyRow(doc, "Monthly repayment amount", l.monthlyRepayment);
    moneyRow(doc, "Amount owing", l.amountOwing);
    moneyRow(doc, "Original loan amount", l.originalLoanAmount);
    row(doc, "Interest rate known", l.interestRateKnown);
    if (l.interestRateKnown === "Yes") row(doc, "Interest rate", l.interestRate ? `${l.interestRate}%` : "");
  });

  const creditCards = liabilities.creditCards || [];
  creditCards.forEach((c, i) => {
    subHeading(doc, `Credit card ${i + 1}`);
    row(doc, "Lender", c.lender);
    row(doc, "Who owns this", c.owner);
    moneyRow(doc, "Monthly repayment amount", c.monthlyRepayment);
    moneyRow(doc, "Credit limit", c.creditLimit);
    moneyRow(doc, "Amount owing", c.amountOwing);
    row(doc, "Interest rate known", c.interestRateKnown);
    if (c.interestRateKnown === "Yes") row(doc, "Interest rate", c.interestRate ? `${c.interestRate}%` : "");
  });

  const oe = info.ongoingExpenses || {};
  if (Object.keys(oe).length) {
    sectionHeading(doc, "Ongoing Expenses");
    row(doc, "Expense types", oe.types);
    const expenseDetails = oe.details || {};
    Object.keys(expenseDetails).forEach((type) => {
      const d = expenseDetails[type] || {};
      subHeading(doc, type);
      moneyRow(doc, "Amount", d.amount);
      row(doc, "Frequency", d.frequency);
    });
    if (oe.otherDescription) row(doc, "Other commitment details", oe.otherDescription);
  }

  doc.end();
}

module.exports = { buildClientPdf };
