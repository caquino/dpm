// TODO: scope down imports
// standard actions and github api libraries
import * as core from '@actions/core'
import * as github from '@actions/github'
// datadog api library
import * as metrics from 'datadog-metrics'

async function run(): Promise<void> {
  core.debug('dpm starting ...')
  try {
    if (github.context.eventName !== 'pull_request') {
      throw new Error('Can only run on pull requests.')
    }

    const githubToken = core.getInput('github-token')
    if (!githubToken) {
      throw new Error('github-token is required')
    }

    const ddapiToken = core.getInput('datadog-api-token')
    if (!ddapiToken) {
      throw new Error('datadog-api-token is required')
    }

    const metricsPrefix = core.getInput('metrics-prefix') || 'dpm'
    const customTags = core.getInput('custom-tags') || '[]'
    const teams = core.getInput('teams') || '[]'

    const repo = github.context.repo
    const workflow = github.context.workflow.toLowerCase().replace(/ /g, '_')
    const pullRequestNumber = github.context.payload.pull_request?.number

    // if teams is defined, convert to tags
    const teamTags = JSON.parse(teams).map((item: string) => `team:${item}`)

    // if customTags is defined, convert to array
    const customTagsParsed = JSON.parse(customTags)

    // here: https://octokit.github.io/rest.js/v18
    const octokit = github.getOctokit(githubToken)

    if (pullRequestNumber === undefined) {
      throw new Error('pullRequestNumber cannot be undefined')
    }

    // initialize datadog api
    metrics.init({
      apiKey: ddapiToken,
      host: 'dpm',
      prefix: metricsPrefix,
      flushIntervalSeconds: 0,
      defaultTags: [
        'env:github',
        `repository:${repo}`,
        `workflow:${workflow}`,
        ...customTagsParsed,
        ...teamTags
      ]
    })

    // gather pull request information
    const {data: pullrequest} = await octokit.rest.pulls.get({
      ...repo,
      pull_number: pullRequestNumber ?? 0
    })

    // gather commit information within pull request
    const {data: commits} = await octokit.rest.pulls.listCommits({
      ...repo,
      pull_number: pullRequestNumber ?? 0
    })

    // common info
    //const baseBranch = pullrequest.base.ref
    //const defaultBranch = pullrequest.base.repo.default_branch
    const createdAt = new Date(pullrequest.created_at).getTime()
    // how many seconds took for the pull request be merged
    if (pullrequest.merged_at) {
      const mergedAt = new Date(pullrequest.merged_at).getTime()
      const mergeTime = Math.abs((mergedAt - createdAt) / 1000)
      metrics.increment('time_to_merge', mergeTime)
    }

    // how many seconds since first commit until pull request was opened
    if (commits[0].commit.committer && commits[0].commit.committer.date) {
      const firstCommit = new Date(commits[0].commit.committer.date).getTime()
      const openTime = Math.abs((createdAt - firstCommit) / 1000)
      metrics.increment('time_to_open', openTime)
    }

    // total lines of code changed
    const diffSize = pullrequest.additions + pullrequest.deletions
    metrics.increment('lines_changed', diffSize)

    // total number of files changed
    // gather files information within pull request
    const {data: files} = await octokit.rest.pulls.listFiles({
      ...repo,
      pull_number: pullRequestNumber ?? 0
    })

    const changedFiles = files.map(f => f.filename).length
    metrics.increment('changed_files', changedFiles)

    core.debug('flushing metrics to datadog ...')
    metrics.flush()
  } catch (err) {
    if (err instanceof Error) core.setFailed(err.message)
  }
}

void run()
