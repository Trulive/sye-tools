#!/usr/bin/env node

import { clusterCreate } from '../sye-cluster/index'
import { syeEnvironmentFile, exit } from '../lib/common'
import * as program from 'commander'

program.usage('[command] <options>')

program
    .command('create <registry-url> <etcd-ip...>')
    .description('Create a configuration file for a cluster')
    .option(
        '-o, --output <filename>',
        'configuration filename, default ./' + syeEnvironmentFile,
        './' + syeEnvironmentFile
    )
    .option('--release <release>', 'Use a specific release. Defaults to latest available in registry')
    .option('-n, --no-check', "Don't try to connect to registry.")
    .option('--internal-ipv6', 'Use IPv6 for internal communication')
    .option('--internal-ipv4-nat', 'Use IPv4 with NAT support for internal communication')
    .action(clusterCreate)

program.command('*').action(help)

program.parse(process.argv)

if (!process.argv.slice(2).length) {
    help()
}

function help() {
    program.outputHelp()
    exit('Use <command> -h for help on a specific command.\n')
}
