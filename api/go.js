module.exports = function handler(req, res) {
  const { id } = req.query;

  if (!id) {
    return res.status(400).send('Missing id');
  }

  let target;
  try {
    target = Buffer.from(id, 'base64url').toString('utf8');
    new URL(target); // throws if not a valid URL
  } catch {
    return res.status(400).send('Invalid id');
  }

  // Only redirect to http/https — never allow javascript: or data: URIs
  if (!/^https?:\/\//i.test(target)) {
    return res.status(400).send('Invalid URL scheme');
  }

  res.setHeader('Cache-Control', 'no-store');
  res.redirect(302, target);
};
