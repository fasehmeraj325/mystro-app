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

  sectionHeading(doc, "Contact & Applicants");
  rows(doc, [
    ["Full name", submission.fullName],
    ["Email", submission.email],
    ["Phone", submission.phone],
    ["Applicants", info.applicants],
  ]);

  sectionHeading(doc, "Personal Details");
  rows(doc, [
    ["Title", p.title],
    ["First name", p.firstName],
    ["Surname", p.surname],
    ["Has middle name", p.hasMiddleName],
    ["Middle name", p.middleName],
    ["Email address", p.email],
    ["Mobile phone", p.mobilePhone],
    ["Australian citizen", p.australianCitizen],
    ["Australian driving licence", p.drivingLicense],
    ["Marital status", p.maritalStatus],
    ["Dependants", p.dependants],
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
  ]);

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

  sectionHeading(doc, "Real Estate Assets");
  row(doc, "Owns investment properties", re.hasInvestmentProperties);
  subHeading(doc, "Existing home");
  moneyRow(doc, "Estimated value", reh.estimatedValue);
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
  const savingsAccounts = assets.savingsAccounts || [];
  savingsAccounts.forEach((s, i) => {
    subHeading(doc, `Savings account ${i + 1}`);
    moneyRow(doc, "Savings amount", s.savingsAmount);
    row(doc, "Financial institution", s.financialInstitution);
  });

  sectionHeading(doc, "Liabilities");
  row(doc, "Liability types", liabilities.types);

  const personalLoans = liabilities.personalLoans || [];
  personalLoans.forEach((l, i) => {
    subHeading(doc, `Personal loan ${i + 1}`);
    row(doc, "Lender", l.lender);
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
    moneyRow(doc, "Monthly repayment amount", c.monthlyRepayment);
    moneyRow(doc, "Credit limit", c.creditLimit);
    moneyRow(doc, "Amount owing", c.amountOwing);
    row(doc, "Interest rate known", c.interestRateKnown);
    if (c.interestRateKnown === "Yes") row(doc, "Interest rate", c.interestRate ? `${c.interestRate}%` : "");
  });

  const fileKeys = Object.keys(submission.files || {});
  if (fileKeys.length) {
    sectionHeading(doc, "Documents Uploaded");
    fileKeys.forEach((k) => {
      const f = submission.files[k];
      row(doc, f.label, f.originalName);
    });
  }

  doc.end();
}

module.exports = { buildClientPdf };
