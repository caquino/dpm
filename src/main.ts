// standard actions and github api libraries
import * as core from '@actions/core'
import * as github from '@actions/github'
// datadog api library
import * as metrics from 'datadog-metrics'

async function run(): Promise<void> {
  try {
    if (github.context.eventName !== 'pull_request') {
      core.setFailed('Can only run on pull requests.')
      return
    }

    const githubToken = core.getInput('github-token')
    if (!githubToken) {
      core.setFailed('github-token is required')
      return
    }

    const ddapiToken = core.getInput('datadog-api-token')
    if (!ddapiToken) {
      core.setFailed('datadog-api-token is required')
      return
    }

    const metricsPrefix = core.getInput('metrics-prefix') || 'dpm'
    const customTags = core.getInput('custom-tags') || '[]'
    const teams = core.getInput('teams') || '[]'

    // the context does for example also include information
    // in the pull request or repository we are issued from
    const context = github.context
    const repo = context.repo
    const workflow = context.workflow.toLowerCase().replace(/ /g, '_')
    const pullRequestNumber = github.context.payload.pull_request?.number

    // if teams is defined, convert to tags
    let teamTags = []
    if (teams) {
      teamTags = JSON.parse(teams).map((item: string) => `team:${item}`)
    }

    // if customTags is defined, convert to array
    let customTagsParsed = []
    if (customTags) {
      customTagsParsed = JSON.parse(customTags)
    }

    // here: https://octokit.github.io/rest.js/v18
    const octokit = github.getOctokit(githubToken)

    if (pullRequestNumber !== undefined) {
      core.setFailed('pullRequestNumber cannot be undefined')
      return
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

    metrics.flush()
  } catch (error) {
    if (error instanceof Error) {
      core.error(error)
      core.setFailed(error.message)
    }
  }
}

run()
