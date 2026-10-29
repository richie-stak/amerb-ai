// The one place that decides who can see, search, and delete which documents. There are three
// knowledge bases:
//
//   Bank-wide   department = 'Bank-wide'       every staff member can read; only admins add/delete
//   Department  department = <dept>, shared    only that department's staff can read; any of
//                                              them can add; the uploader or an admin can delete
//   Personal    is_personal = 1                only the person who created it (chat attachments,
//                                              AI-generated files, fetched web pages)
//
// Admins can see and manage every document (they administer the bank's data), but their own chat
// searches only draw on the same knowledge bases as anyone else's: bank-wide, their own
// department, and their own personal files.
const { BANKWIDE_DEPARTMENT } = require('./departments');

const SCOPES = ['global', 'department', 'personal'];

function scopeOf(doc) {
  if (doc.is_personal) return 'personal';
  if (doc.department === BANKWIDE_DEPARTMENT) return 'global';
  return 'department';
}

function canAccessDoc(doc, user) {
  if (!doc || !user) return false;
  if (user.role === 'admin' || doc.user_id === user.id) return true;
  const scope = scopeOf(doc);
  if (scope === 'global') return true;
  if (scope === 'department') return Boolean(user.department) && doc.department === user.department;
  return false;
}

function canDeleteDoc(doc, user) {
  if (!doc || !user) return false;
  if (user.role === 'admin') return true;
  // Bank-wide documents are bank policy — only admins remove them, even one an admin originally
  // uploaded who has since been demoted.
  if (scopeOf(doc) === 'global') return false;
  return doc.user_id === user.id;
}

// SQL condition (for a `documents` table aliased `d`) matching what `user` may see and search in
// chat — used by both the document list and keyword retrieval, so the two can never disagree.
function searchableWhere(user) {
  return {
    sql: `(d.user_id = ? OR d.department = ? OR (d.is_personal = 0 AND d.department = ?))`,
    params: [user.id, BANKWIDE_DEPARTMENT, user.department || '__none__'],
  };
}

module.exports = { SCOPES, scopeOf, canAccessDoc, canDeleteDoc, searchableWhere };
