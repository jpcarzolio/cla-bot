const gh = require("parse-github-url");

const getOrgConfigUrl = repositoryUrl => {
  const ghData = gh(repositoryUrl);
  const ghUrl = `https://${ghData.host}/repos/${
    ghData.owner
  }/clabot-config/contents/.clabot`;
  return ghUrl;
};

module.exports = {
  getOrgConfigUrl
};
