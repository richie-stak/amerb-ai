const DEPARTMENTS = [
  'Credit',
  'Loans',
  'Finance',
  'Operations',
  'Customer Service',
  'HR',
  'IT',
  'Compliance & Risk',
  'Audit',
  'Management',
  'General',
];

// Not a real department a user can belong to — a sentinel value tagged on documents an admin
// marks as bank-wide, so they're visible to every staff member regardless of their own
// department, and shown as their own distinct section rather than folded into a department's list.
const BANKWIDE_DEPARTMENT = 'Bank-wide';

module.exports = { DEPARTMENTS, BANKWIDE_DEPARTMENT };
