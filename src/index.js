const fs = require("fs");
const path = require("path");
const contributionVerifier = require("./contributionVerifier");
const installationToken = require("./installationToken");
const is = require("is_js");
const uuid = require("uuid/v4");
const githubApi = require("./githubApi");
const logger = require("./logger");
const { getOrgConfigUrl } = require("./utils");

const defaultConfig = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "default.json"))
);

const sortUnique = arr =>
  arr
    .sort((a, b) => a - b)
    .filter((value, index, self) => self.indexOf(value, index + 1) === -1);

const validAction = webhook =>
  webhook.action === "opened" ||
  webhook.action === "synchronize" ||
  // issues do not have a body.issue.pull_request property, whereas PRs do
  (webhook.action === "created" && webhook.issue.pull_request);

// depending on the event type, the way the location of the PR and issue URLs are different
const gitHubUrls = webhook =>
  webhook.action === "created"
    ? {
        pullRequest: webhook.issue.pull_request.url,
        issue: webhook.issue.url
      }
    : {
        pullRequest: webhook.pull_request.url,
        issue: webhook.pull_request.issue_url
      };

const commentSummonsBot = comment =>
  comment.match(new RegExp(`@${process.env.BOT_NAME}(\\[bot\\])?\\s*check`)) !==
  null;

const obtainToken = async webhook => {
  // if we are running as an integration, obtain the required integration token
  if (
    process.env.INTEGRATION_ENABLED &&
    process.env.INTEGRATION_ENABLED === "true"
  ) {
    logger.info(
      "Bot installed as an integration, obtaining installation token"
    );
    return await installationToken(webhook.installation.id);
  } else {
    logger.info("Bot installed as a webhook, using access token");
    return process.env.GITHUB_ACCESS_TOKEN;
  }
};

const response = body => ({
  statusCode: 200,
  body: JSON.stringify(body)
});

const applyToken = token => {
  const api = {};
  githubRequest = githubApi.githubRequest;
  Object.keys(githubApi).forEach(apiMethod => {
    api[apiMethod] = (...args) =>
      githubRequest(githubApi[apiMethod].apply(null, args), token);
  });
  return api;
};

// the lambda interface is a bit clumsy, this adapts it into something more manageable
const constructHandler = fn => async ({ body }, lambdaContext, callback) => {
  try {
    // serverless takes the request body and stringifies it
    const res = await fn(JSON.parse(body));

    if (typeof res === "string") {
      logger.debug("integration webhook callback response", res);
      callback(null, response({ message: res }));
    } else {
      logger.error(`unexpected lambda function return value ${res}`);
    }
  } catch (err) {
    logger.error(err.toString());
    callback(err.toString());
  }

  logger.flush();
};

exports.handler = constructHandler(async webhook => {
  logger.debug("lambda invoked", webhook);

  if (!validAction(webhook)) {
    return `ignored action of type ${webhook.action}`;
  }

  const { pullRequest: pullRequestUrl, issue: issueUrl } = gitHubUrls(webhook);

  // determine the URL for storing the event log
  const org = pullRequestUrl.split("/")[4];
  const logUrl = `${org}-${uuid()}`;
  const logFile = `https://s3.amazonaws.com/${
    process.env.LOGGING_BUCKET
  }/${logUrl}`;
  logger.logFile(logUrl);

  // obtain the token and apply it to all of our API methods
  const token = await obtainToken(webhook);
  const {
    getLabels,
    getOrgConfig,
    getReadmeUrl,
    getFile,
    addLabel,
    getCommits,
    setStatus,
    addCommentNoCLA,
    addCommentUnidentified,
    deleteLabel,
    addComment,
    updateFile
  } = applyToken(token);


  // Load config

  let isConfigOrgWide = false;
  let configUrl;
  let orgConfigMeta;
  try {
    logger.info("Attempting to obtain organisation level .clabot file URL");
    orgConfigMeta = await getOrgConfig(webhook);
    logger.info("Organisation configuration found!");
    isConfigOrgWide = true;
    configUrl = getOrgConfigUrl(webhook.repository.url);
  } catch (e) {
    logger.info(
      "Organisation configuration not found, resolving .clabot URL at project level"
    );
    orgConfigMeta = await getReadmeUrl(webhook);
    configUrl = `${webhook.repository.url}/contents/.clabot`;
  }

  logger.info(
    `Obtaining .clabot configuration file from ${
      orgConfigMeta.download_url.split("?")[0]
    }`
  );

  const loadedConfig = await getFile(orgConfigMeta);

  if (!is.json(loadedConfig)) {
    logger.error("The .clabot file is not valid JSON");
    await setStatus(webhook, headSha, "error", logFile);
    throw new Error("The .clabot file is not valid JSON");
  }

  // merge with default config options
  const botConfig = Object.assign({}, defaultConfig, loadedConfig);


  // if (webhook.action === "created") {
  //   if (!commentSummonsBot(webhook.comment.body)) {
  //     return "the comment didnt summon the cla-bot";
  //   } else {
  //     if (webhook.comment.user.login === `${process.env.BOT_NAME}[bot]`) {
  //       return "the cla-bot summoned itself. Ignored!";
  //     }
  //     logger.info("The cla-bot has been summoned by a comment");
  //   }
  // }
  let command;
  if (webhook.action === "created") {
    command = getBotCommandFromComment(webhook.comment.body);

    if (!command) {
      return "the comment didn't summon the cla-bot";
    }
    if (command === "invalid") {
      await addComment(
        webhook.issue.url,
        `@${webhook.comment.user.login}, unknown cla-bot command. Try ` +
        `\`@${process.env.BOT_NAME} check\` or ` +
        `\`@${process.env.BOT_NAME} accept\`.`
      );
      return "invalid cla-bot command";
    }
    if (webhook.comment.user.login === `${process.env.BOT_NAME}[bot]`) {
      return "the cla-bot summoned itself. Ignored!";
    }

    logger.info(
      `The cla-bot has been summoned by a comment with command: ${command}`
    );

    if (command === "accept") {
      const [ok, msg] = await handleAcceptCommand();
      logger.info(msg);
      if (!ok) {
        return msg;
      }
      botConfig.contributors.push(webhook.comment.user.login);
    }
  }

  logger.info(`Checking CLAs for pull request ${pullRequestUrl}`);


  logger.info("Obtaining the list of commits for the pull request");
  let commits = await getCommits(pullRequestUrl);

  // commits = commits instanceof Array ? commits : [commits];

  console.dir(commits, { depth: 10 });

  logger.info(
    `Total Commits: ${commits.length}, checking CLA status for committers`
  );

  // PRs include the head sha, for comments we have to determine this from the commit history
  let headSha;
  if (webhook.pull_request) {
    headSha = webhook.pull_request.head.sha;
  } else {
    headSha = commits[commits.length - 1].sha;
  }

  const unresolvedLoginNames = sortUnique(
    commits.filter(c => c.author == null).map(c => c.commit.author.name)
  );


  async function removeLabelAndSetFailureStatus(users) {
    await deleteLabel(issueUrl, botConfig.label);
    await setStatus(webhook, headSha, "error", logFile);
    return `CLA has not been signed by users ${users}, added a comment to ${pullRequestUrl}`;
  }

  async function addLabelAndSetSuccessStatus() {
    const labels = await getLabels(issueUrl);

    // check whether this label already exists
    if (!labels.some(l => l.name === botConfig.label)) {
      await addLabel(issueUrl, botConfig.label);
    } else {
      logger.info(`The pull request already has the label ${botConfig.label}`);
    }

    await setStatus(webhook, headSha, "success", logFile);
    return `added label ${botConfig.label} to ${pullRequestUrl}`;
  }

  async function updateOrgWideContributorList(username) {
    const updatedConfig = { ...loadedConfig };
    updatedConfig.contributors = [
      ...updatedConfig.contributors,
      webhook.comment.user.login
    ].sort();

    await updateFile(
      configUrl,
      orgConfigMeta.sha,
      JSON.stringify(updatedConfig, null, 2),
      `Add ${username} to CLA contributor list`
    );
  };

  async function handleAcceptCommand() {
    // Step 1: Get commit authors and ensure commenter is one of them
    const commits = await getCommits(pullRequestUrl);
    const commitAuthors = commits.map(c => c.author?.login).filter(Boolean);

    if (!commitAuthors.includes(webhook.comment.user.login)) {
      await addComment(issueUrl, `@${webhook.comment.user.login}, only authors of commits in this PR may accept the CLA.`);
      return [false, "accept command ignored — user not a contributor"];
    }

    // Step 2: ensure we're using an org-wide .clabot file (we only support that, for now at least)
    const acceptCmdSupported = isConfigOrgWide && botConfig.contributors instanceof Array; // ||
      // !isConfigOrgWide && (`${botConfig.contributors || botConfig.contributorListGithubUrl}`.indexOf("api.github.com") !== -1);
    if (!acceptCmdSupported) {
      await addComment(issueUrl, `@${webhook.comment.user.login}, automatic CLA acceptance is only supported when using an org-wide .clabot file.`);
      return [false, "accept command skipped — unsupported CLA config source"];
    }

    // We already know we're using a contributor array, from an org-wide .clabot file
    const contributorList = botConfig.contributors;

    // Step 3: Add user to list if not already there
    if (contributorList.includes(webhook.comment.user.login)) {
      await addComment(issueUrl, `@${webhook.comment.user.login}, you're already listed as a CLA-signed contributor.`);
      return [false, "accept command skipped — user already listed"];
    }

    // Step 4: Commit updated list back to GitHub
    await updateOrgWideContributorList(webhook.comment.user.login);
    await addComment(issueUrl, `@${webhook.comment.user.login}, thank you — your CLA acceptance has been recorded.`);
    return [true, "successfully processed accept command"];
  }

  let message;
  if (unresolvedLoginNames.length > 0) {
    const unidentifiedString = unresolvedLoginNames.join(", ");
    logger.info(
      `Some commits from the following contributors are not signed with a valid email address: ${unidentifiedString}. `
    );
    await addCommentUnidentified(
      issueUrl,
      botConfig.messageMissingEmail,
      unidentifiedString
    );
    message = await removeLabelAndSetFailureStatus(unidentifiedString);
  } else {
    // the GitHub commit contains git author information (within commit.author), and GitHub author
    // information (with author), we need both depending on verification more, so combine.
    // see: https://developer.github.com/v3/pulls/#list-commits-on-a-pull-request
    const committers = commits.map(c => ({
      ...(c.commit ? c.commit.author : {}),
      ...c.author
    }));
    const verifier = contributionVerifier(botConfig);
    const nonContributors = await verifier(committers, token);

    if (nonContributors.length === 0) {
      logger.info(
        "All contributors have a signed CLA, adding success status to the pull request and a label"
      );

      message = await addLabelAndSetSuccessStatus();
    } else {
      const usersWithoutCLA = sortUnique(nonContributors)
        .map(contributorId => `@${contributorId}`)
        .join(", ");
      logger.info(
        `The contributors ${usersWithoutCLA} have not signed the CLA, adding error status to the pull request`
      );
      await addCommentNoCLA(issueUrl, botConfig.message, usersWithoutCLA);

      message = await removeLabelAndSetFailureStatus(usersWithoutCLA);
    }
  }

  if (command === "check") {
    await addComment(issueUrl, botConfig.recheckComment);
  }

  return message;
});

function getBotCommandFromComment(comment) {
  const regex = new RegExp(`@${process.env.BOT_NAME}(\\[bot\\])?\\s*(\\w+)`);
  const match = comment.match(regex);
  if (match) {
    const command = match[2].toLowerCase();
    if (["check", "accept"].includes(command)) {
      return command;
    }
    return "invalid"; // unrecognized command
  }
  return null;
}

exports.test = {
  // commentSummonsBot
};
