import { BaseCommand } from '@yarnpkg/cli'
import { Configuration, Project } from '@yarnpkg/core'
import * as execUtils from '@yarnpkg/core/lib/execUtils'
import { parseArgsStringToArgv } from 'string-argv'

import {
    getPackageAccessibleBinaries,
    makeScriptEnv,
} from '@yarnpkg/core/lib/scriptUtils'
import {
    Filename,
    NativePath,
    PortablePath,
    ppath,
    toFilename,
    xfs,
} from '@yarnpkg/fslib'
import chalk from 'chalk'
import { execSync, exec } from 'child_process'
import { Command, Usage } from 'clipanion'
import path from 'path'
import { memoizer } from '..'

// eslint-disable-next-line arca/no-default-export
export default class RunCommand extends BaseCommand {
    @Command.String(`--inspect`, { tolerateBoolean: true })
    inspect: string | boolean = false

    @Command.String(`--inspect-brk`, { tolerateBoolean: true })
    inspectBrk: string | boolean = false

    // This flag is mostly used to give users a way to configure node-gyp. They
    // just have to add it as a top-level workspace.
    @Command.Boolean(`-T,--top-level`, { hidden: true })
    topLevel: boolean = false

    @Command.Boolean(`--only-scripts`, { hidden: false })
    onlyScripts: boolean = false

    // Some tools (for example text editors) want to call the real binaries, not
    // what their users might have remapped them to in their `scripts` field.
    @Command.Boolean(`-B,--binaries-only`, { hidden: true })
    binariesOnly: boolean = false

    // The v1 used to print the Yarn version header when using "yarn run", which
    // was messing with the output of things like `--version` & co. We don't do
    // this anymore, but many workflows use `yarn run --silent` to make sure that
    // they don't get this header, and it makes sense to support it as well (even
    // if it's a no-op in our case).
    @Command.Boolean(`--silent`, { hidden: true })
    silent?: boolean

    @Command.String()
    scriptName!: string

    @Command.Proxy()
    args: Array<string> = []

    static usage: Usage = Command.Usage({
        description: `run a script defined in the package.json`,
        details: `
      This command will run a tool. The exact tool that will be executed will depend on the current state of your workspace:

      - If the \`scripts\` field from your local package.json contains a matching script name, its definition will get executed.

      - Otherwise, if one of the local workspace's dependencies exposes a binary with a matching name, this binary will get executed (the \`--inspect\` and \`--inspect-brk\` options will then be forwarded to the underlying Node process).

      - Otherwise, if the specified name contains a colon character and if one of the workspaces in the project contains exactly one script with a matching name, then this script will get executed.

      Whatever happens, the cwd of the spawned process will be the workspace that declares the script (which makes it possible to call commands cross-workspaces using the third syntax).
    `,
        examples: [
            [`Run the tests from the local workspace`, `$0 run test`],
            [`Same thing, but without the "run" keyword`, `$0 test`],
            [`Inspect Webpack while running`, `$0 run --inspect-brk webpack`],
        ],
    })

    @Command.Path(`lightrun`, 'l')
    async execute() {
        const configuration = await Configuration.find(
            this.context.cwd,
            this.context.plugins,
        )
        return this.execCommand({
            args: this.args,
            onlyScripts: this.onlyScripts,
            binaryName: this.scriptName,
            configuration,
        })
    }
    async execCommand({
        binaryName,
        configuration,
        args,
        onlyScripts,
        ignoreScripts = [],
    }) {
        // TODO remove quotes from args
        args = args.map((x) => x.trim()).filter(Boolean)
        if (process.env.DEBUG_LIGHT_YARN) {
            console.log('this.context.cwd', this.context.cwd)
            console.log('binaryName', binaryName)
            console.log('args', args)
        }
        // if a script exists in package.json, run that
        const packageJSON = getPackageJSON(configuration.startingCwd)
        if (packageJSON) {
            // console.log(this.scriptName, packageJSON.scripts)
            if (
                Object.keys(packageJSON.scripts).includes(binaryName) &&
                !ignoreScripts.includes(binaryName)
            ) {
                const content = packageJSON.scripts[binaryName]
                // TODO parse command into args
                const parsed = parseArgsStringToArgv(content)
                return this.execCommand({
                    args: [...parsed.slice(1), ...args],
                    binaryName: parsed[0],
                    configuration,
                    onlyScripts: false,
                    ignoreScripts: [...ignoreScripts, binaryName],
                })
            }
        }

        if (onlyScripts) {
            return new Promise((res, rej) => {
                this.context.stderr.write(
                    'skipping missing script ' + binaryName + '\n',
                    (e) => {
                        if (e) {
                            rej(e)
                        }
                        res(0)
                    },
                )
                // this.context.stderr.end()
            })
        }

        const getBins = await memoizer.fn(
            async (cwd: PortablePath) => {
                let { project, workspace, locator } = await Project.find(
                    configuration,
                    cwd,
                )
                await project.restoreInstallState()
                // locator = this.topLevel
                //   ? project.topLevelWorkspace.anchoredLocator
                //   : locator;
                const maps = await getPackageAccessibleBinaries(locator, {
                    project,
                })
                return Object.fromEntries(maps.entries())
            },
            {
                cacheId: 'fn',
            },
        )

        const packageAccessibleBinaries = await getBins(this.context.cwd)
        let binary = packageAccessibleBinaries[binaryName]

        //  if no bin found on packages deps, just run the command
        if (!binary) {
            // console.log(
            //     `no binary for ${binaryName} found in ${Object.keys(
            //         packageAccessibleBinaries,
            //     )}`,
            // )
            return this.cli.run([`lightexec`, binaryName, ...args])
        }

        // run the dep script with yarn node
        return await xfs.mktempPromise(async (binFolder) => {
            const [, binaryPath] = binary
            const env = await makeScriptEnv({
                binFolder,
                // project: (await Project.find(configuration, this.context.cwd)) as any,
            })

            for (const binaryName in packageAccessibleBinaries) {
                const [, binaryPath] = packageAccessibleBinaries[binaryName]
                await makePathWrapper(
                    env.BERRY_BIN_FOLDER as PortablePath,
                    toFilename(binaryName),
                    process.execPath,
                    [binaryPath],
                )
            }

            let result
            // console.log(this.context.cwd)
            try {
                result = await execUtils.pipevp(
                    process.execPath,
                    [
                        ...getNodeArgs({
                            inspect: this.inspect,
                            inspectBrk: this.inspectBrk,
                        }),
                        binaryPath,
                        ...args,
                    ],
                    {
                        cwd: this.context.cwd,
                        env: {
                            ...process.env,
                            ...env,
                            NODE_OPTIONS:
                                (process.env.NODE_OPTIONS || '') +
                                ' --require ' +
                                path.resolve(
                                    configuration.projectCwd as any,
                                    '.pnp.js',
                                ),
                        },
                        stdin: this.context.stdin,
                        stdout: this.context.stdout,
                        stderr: this.context.stderr,
                    },
                )
            } finally {
                await xfs.removePromise(env.BERRY_BIN_FOLDER as PortablePath)
            }

            return result.code
        })
    }
}

function getNodeArgs({ inspectBrk, inspect }) {
    const nodeArgs: string[] = []

    if (inspect) {
        if (typeof inspect === `string`) {
            nodeArgs.push(`--inspect=${inspect}`)
        } else {
            nodeArgs.push(`--inspect`)
        }
    }

    if (inspectBrk) {
        if (typeof inspectBrk === `string`) {
            nodeArgs.push(`--inspect-brk=${inspectBrk}`)
        } else {
            nodeArgs.push(`--inspect-brk`)
        }
    }
    return nodeArgs
}

function getPackageJSON(cwd) {
    try {
        return require(path.resolve(cwd, 'package.json'))
    } catch {
        return null
    }
}

async function makePathWrapper(
    location: PortablePath,
    name: Filename,
    argv0: NativePath,
    args: Array<string> = [],
) {
    if (process.platform === `win32`)
        await xfs.writeFilePromise(
            ppath.format({ dir: location, name, ext: `.cmd` }),
            `@"${argv0}" ${args
                .map((arg) => `"${arg.replace(`"`, `""`)}"`)
                .join(` `)} %*\n`,
        )

    await xfs.writeFilePromise(
        ppath.join(location, name),
        `#!/bin/sh\nexec "${argv0}" ${args
            .map((arg) => `'${arg.replace(/'/g, `'"'"'`)}'`)
            .join(` `)} "$@"\n`,
    )
    await xfs.chmodPromise(ppath.join(location, name), 0o755)
}
