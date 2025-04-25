const handlebars = require("handlebars");
const requestp = require("./requestAsPromise");
const { getOrgConfigUrl } = require("./utils");

exports.githubRequest = (opts, token, method = "POST") =>
  requestp(
    Object.assign(
      {},
      {
        json: true,
        headers: {
          Authorization: `token ${token}`,
          "User-Agent": "github-cla-bot",
          Accept: "application/vnd.github.v3+json"
        },
        method
      },
      opts
    )
  );

exports.getOrgConfig = webhook => ({
  url: getOrgConfigUrl(webhook.repository.url),
  method: "GET"
});

exports.getReadmeUrl = webhook => ({
  url: `${webhook.repository.url}/contents/.clabot`,
  method: "GET"
});

exports.getFile = body => ({
  url: body.download_url,
  method: "GET"
});

exports.addLabel = (issueUrl, label) => ({
  url: `${issueUrl}/labels`,
  body: [label]
});

exports.getLabels = issueUrl => ({
  url: `${issueUrl}/labels`,
  method: "GET"
});

exports.deleteLabel = (issueUrl, label) => ({
  url: `${issueUrl}/labels/${label}`,
  method: "DELETE"
});

exports.getCommits = pullRequestUrl => ({
  url: `${pullRequestUrl}/commits`,
  method: "GET"
});

exports.setStatus = (webhook, headSha, state, target_url) => ({
  url: `${webhook.repository.url}/statuses/${headSha}`,
  body: {
    state,
    context: "verification/cla-signed",
    target_url
  }
});

exports.addComment = (issueUrl, comment) => ({
  url: `${issueUrl}/comments`,
  body: {
    body: comment
  }
});

exports.addCommentNoCLA = (issueUrl, message, usersWithoutCLA) => {
  // TODO: move this logic out of this file
  const template = handlebars.compile(message);
  return {
    url: `${issueUrl}/comments`,
    body: {
      body: template({ usersWithoutCLA })
    }
  };
};

exports.addCommentUnidentified = (issueUrl, message, unidentifiedUsers) => {
  const template = handlebars.compile(message);
  return {
    url: `${issueUrl}/comments`,
    body: {
      body: template({ unidentifiedUsers })
    }
  };
};

exports.updateFile = (url, prevSha, content, message) => {
  const contentEncoded = Buffer.from(content).toString("base64");
  const body = {
    message,
    content: contentEncoded,
    sha: prevSha
  };

  return {
    url,
    method: "PUT",
    body
  };
};
