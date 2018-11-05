import { consoleLog, execSync, readPackageFile } from '../../lib/common'
import { exec, defaultClusterAutoscalerSpName } from './utils'
import { ensureLoggedIn } from './utils'
import * as util from 'util'
import * as fs from 'fs'
import {
    installTillerRbac,
    installTiller,
    waitForTillerStarted,
    installNginxIngress,
    installPrometheus,
    installPrometheusOperator,
    installPrometheusAdapter,
} from '../../lib/k8s'
const debug = require('debug')('aks/cluster-create')

export interface Context {
    subscriptionArgs: string[]
    resourceGroup: string
    location: string
    clusterName: string
    kubernetesVersion: string
    // Derived
    servicePrincipalPassword: string
    servicePrincipalHomePage: string
    vnetName: string
    subnetName: string
    subnetCidr: string
    nodeCount: number
    minNodeCount: number
    adminUsername: string
    vmSize: string
    kubeconfig: string
    k8sResourceGroup: string
    clusterAutoscalerVersion?: string
    autoscalerSpName?: string
    autoscalerSpPassword?: string
}

async function createSubnet(ctx: Context) {
    try {
        consoleLog(`Subnet ${ctx.subnetName}:`)
        await exec('az', [
            'network',
            'vnet',
            'subnet',
            'show',
            ...ctx.subscriptionArgs,
            '--resource-group',
            ctx.resourceGroup,
            '--vnet-name',
            ctx.vnetName,
            '--name',
            ctx.subnetName,
        ])
        consoleLog('  Already exists - OK.')
    } catch (ex) {
        consoleLog('  Creating...')
        await exec('az', [
            'network',
            'vnet',
            'subnet',
            'create',
            ...ctx.subscriptionArgs,
            '--resource-group',
            ctx.resourceGroup,
            '--vnet-name',
            ctx.vnetName,
            '--name',
            ctx.subnetName,
            '--address-prefix',
            ctx.subnetCidr,
        ])
        consoleLog('  Done.')
    }
}

async function createCluster(ctx: Context) {
    try {
        consoleLog(`AKS Cluster ${ctx.clusterName}:`)
        await exec('az', [
            'aks',
            'show',
            ...ctx.subscriptionArgs,
            '--resource-group',
            ctx.resourceGroup,
            '--name',
            ctx.clusterName,
        ])
        consoleLog('  Already exists - OK.')
    } catch (ex) {
        consoleLog('  Getting appId...')
        const appId = (await exec('az', [
            'ad',
            'sp',
            'show',
            ...ctx.subscriptionArgs,
            '--id',
            ctx.servicePrincipalHomePage,
            '--query',
            'appId',
            '--output',
            'tsv',
        ]))[0]
        debug('appId', appId)
        consoleLog('  Getting subnet id...')
        const subnetId = (await exec('az', [
            'network',
            'vnet',
            'subnet',
            'show',
            ...ctx.subscriptionArgs,
            '--resource-group',
            ctx.resourceGroup,
            '--vnet-name',
            ctx.vnetName,
            '--name',
            ctx.subnetName,
            '--query',
            'id',
            '--output',
            'tsv',
        ]))[0]
        debug('subnetId', subnetId)
        consoleLog('  Creating AKS cluster...')
        await exec('az', [
            'aks',
            'create',
            ...ctx.subscriptionArgs,
            '--resource-group',
            ctx.resourceGroup,
            '--name',
            ctx.clusterName,
            '--node-count',
            ctx.nodeCount.toString(),
            '--kubernetes-version',
            ctx.kubernetesVersion,
            '--admin-username',
            ctx.adminUsername,
            '--node-vm-size',
            ctx.vmSize,
            '--network-plugin',
            'azure',
            '--vnet-subnet-id',
            subnetId,
            '--service-principal',
            appId,
            '--client-secret',
            ctx.servicePrincipalPassword,
        ])
        consoleLog('  Done.')
    }
}

async function addPublicIps(ctx: Context) {
    consoleLog(`Adding public IPs to VMs in AKS cluster ${ctx.clusterName}:`)
    consoleLog('  Listing VMs...')
    const vmNames = await exec('az', [
        'vm',
        'list',
        ...ctx.subscriptionArgs,
        '--resource-group',
        ctx.k8sResourceGroup,
        '--query',
        '[].name',
        '--output',
        'tsv',
    ])
    for (const vmName of vmNames.filter((x) => !!x)) {
        const publicIpName = `${vmName}-public-ip`
        consoleLog(`  Inspecting VM ${vmName}...`)
        try {
            await exec('az', [
                'network',
                'public-ip',
                'show',
                ...ctx.subscriptionArgs,
                '--resource-group',
                ctx.k8sResourceGroup,
                '--name',
                publicIpName,
            ])
            consoleLog(`    Public IP for VM "${vmName}" already exists - OK.`)
        } catch (ex) {
            consoleLog('    Adding public IP...')
            await exec('az', [
                'network',
                'public-ip',
                'create',
                ...ctx.subscriptionArgs,
                '--resource-group',
                ctx.k8sResourceGroup,
                '--location',
                ctx.location,
                '--name',
                publicIpName,
                '--allocation-method',
                'Dynamic',
            ])
            consoleLog('    Finding name of NIC...')
            const nicName = (await exec('az', [
                'vm',
                'nic',
                'list',
                ...ctx.subscriptionArgs,
                '--resource-group',
                ctx.k8sResourceGroup,
                '--vm-name',
                vmName,
                '--query',
                '[].id',
                '--output',
                'tsv',
            ]))[0].replace(/\/.*\//, '')
            debug('nicName', nicName)
            consoleLog('    Finding ipconfiguration...')
            const ipConfigName = (await exec('az', [
                'network',
                'nic',
                'ip-config',
                'list',
                ...ctx.subscriptionArgs,
                '--resource-group',
                ctx.k8sResourceGroup,
                '--nic-name',
                nicName,
                '--query',
                '[] | [?primary].name',
                '--output',
                'tsv',
            ]))[0]
            debug('ipConfigName', ipConfigName)
            consoleLog('    Updating NIC...')
            await exec('az', [
                'network',
                'nic',
                'ip-config',
                'update',
                ...ctx.subscriptionArgs,
                '--resource-group',
                ctx.k8sResourceGroup,
                '--nic-name',
                nicName,
                '--name',
                ipConfigName,
                '--public-ip-address',
                publicIpName,
            ])
            consoleLog('    Public IP Configured - OK.')
        }
    }
    consoleLog('  All VMs have their Public IPs configured')
}

async function enableSspPort(ctx: Context) {
    const portNumber = 2123
    const ruleName = `UDP_${portNumber}`
    consoleLog(`Enable SSP in network security rules:`)
    consoleLog('  Finding NSG...')
    const nsgName = (await exec('az', [
        'network',
        'nsg',
        'list',
        ...ctx.subscriptionArgs,
        '--resource-group',
        ctx.k8sResourceGroup,
        '-o',
        'tsv',
        '--query',
        '[].name',
    ]))[0]
    try {
        consoleLog('  Inspecting NSG Rule...')
        await exec('az', [
            'network',
            'nsg',
            'rule',
            'show',
            ...ctx.subscriptionArgs,
            '--resource-group',
            ctx.k8sResourceGroup,
            '--nsg-name',
            nsgName,
            '--name',
            ruleName,
        ])
        consoleLog('  Already configured - OK.')
    } catch (ex) {
        consoleLog('  Configure NSG rule...')
        await exec('az', [
            'network',
            'nsg',
            'rule',
            'create',
            ...ctx.subscriptionArgs,
            '--resource-group',
            ctx.k8sResourceGroup,
            '--nsg-name',
            nsgName,
            '--name',
            ruleName,
            '--description',
            'Sye SSP traffic (UDP 2123)',
            '--priority',
            '200',
            '--protocol',
            'Udp',
            '--destination-port-ranges',
            portNumber.toString(),
        ])
        consoleLog('  Done.')
    }
}

async function downloadKubectlCredentials(ctx: Context) {
    consoleLog(`Download kubectl credentials to ${ctx.kubeconfig}.`)
    if (fs.existsSync(ctx.kubeconfig)) {
        consoleLog('  Deleting old file...')
        await util.promisify(fs.unlink)(ctx.kubeconfig)
    }
    consoleLog('  Downloading new file from Azure AKS...')
    await exec('az', [
        'aks',
        'get-credentials',
        ...ctx.subscriptionArgs,
        '--resource-group',
        ctx.resourceGroup,
        '--name',
        ctx.clusterName,
        '--file',
        ctx.kubeconfig,
    ])
    consoleLog('  Done.')
}

async function installClusterAutoscalerSecret(ctx: Context, spPassword: string, spName?: string) {
    const subscriptionId = (await exec('az', [
        'account',
        'show',
        ...ctx.subscriptionArgs,
        '--query',
        'id',
        '--output',
        'tsv',
    ]))[0]
    const tenantId = (await exec('az', [
        'account',
        'show',
        ...ctx.subscriptionArgs,
        '--query',
        'tenantId',
        '--output',
        'tsv',
    ]))[0]
    const clientId = (await exec('az', [
        'ad',
        'sp',
        'show',
        ...ctx.subscriptionArgs,
        '--id',
        `http://${spName || defaultClusterAutoscalerSpName(ctx.resourceGroup, ctx.clusterName)}`,
        '--query',
        'appId',
        '--output',
        'tsv',
    ]))[0]
    const secret = `---
apiVersion: v1
kind: Secret
metadata:
  name: cluster-autoscaler-azure
  namespace: kube-system
data:
  ClientID: ${Buffer.from(clientId).toString('base64')}
  ClientSecret: ${Buffer.from(spPassword).toString('base64')}
  ResourceGroup: ${Buffer.from(ctx.resourceGroup).toString('base64')}
  SubscriptionID: ${Buffer.from(subscriptionId).toString('base64')}
  TenantID: ${Buffer.from(tenantId).toString('base64')}
  VMType: ${Buffer.from('AKS').toString('base64')}
  ClusterName: ${Buffer.from(ctx.clusterName).toString('base64')}
  NodeResourceGroup: ${Buffer.from(ctx.k8sResourceGroup).toString('base64')}
---`
    consoleLog(`Installing/updating Cluster Autoscaler Secret:`)
    execSync(`kubectl --kubeconfig ${ctx.kubeconfig} apply -f -`, {
        input: secret,
    })
    consoleLog('  Done.')
}

async function installClusterAutoscaler(
    kubeconfig: string,
    caVersion: string,
    minNodeCount: number,
    maxNodeCount: number
) {
    const agentpool = (await exec('kubectl', [
        'get',
        'nodes',
        '-o',
        "jsonpath='{.items[0].metadata.labels.agentpool}'",
    ]))[0]
    debug('agentpool', agentpool)
    consoleLog(`Installing/updating Cluster Autoscaler:`)
    execSync(`kubectl --kubeconfig ${kubeconfig} apply -f -`, {
        input: readPackageFile('sye-aks/aks-cluster-autoscaler.yaml')
            .toString()
            .replace('${caVersion}', caVersion)
            .replace('${minNodes}', minNodeCount.toString())
            .replace('${maxNodes}', maxNodeCount.toString())
            .replace('${nodePool}', agentpool),
    })
    consoleLog('  Done.')
}

export async function createAksCluster(
    subscription: string | undefined,
    options: {
        resourceGroup: string
        location: string
        clusterName: string
        kubernetesVersion: string
        vmSize: string
        nodeCount: number
        minNodeCount: number
        servicePrincipalPassword: string
        kubeconfig: string
        subnetCidr: string
        clusterAutoscalerVersion?: string
        autoscalerSpName?: string
        autoscalerSpPassword?: string
    }
) {
    const subscriptionArgs = []
    if (subscription) {
        subscriptionArgs.push('--subscription')
        subscriptionArgs.push(subscription)
    }
    const ctx: Context = {
        ...options,
        subscriptionArgs,
        adminUsername: 'netinsight',
        servicePrincipalHomePage: `http://${options.resourceGroup}-sp`,
        vnetName: options.resourceGroup,
        subnetName: `${options.clusterName}-subnet`,
        k8sResourceGroup: `MC_${options.resourceGroup}_${options.clusterName}_${options.location}`,
    }
    await ensureLoggedIn()
    await createSubnet(ctx)
    await createCluster(ctx)
    await addPublicIps(ctx)
    await enableSspPort(ctx)
    await downloadKubectlCredentials(ctx)
    installTillerRbac(ctx.kubeconfig)
    installTiller(ctx.kubeconfig)
    waitForTillerStarted(ctx.kubeconfig)
    installNginxIngress(ctx.kubeconfig)
    if (options.clusterAutoscalerVersion && options.autoscalerSpPassword) {
        installPrometheusOperator(ctx.kubeconfig)
        installPrometheus(ctx.kubeconfig)
        installPrometheusAdapter(ctx.kubeconfig)
        await installClusterAutoscalerSecret(ctx, options.autoscalerSpPassword, ctx.autoscalerSpName)
        await installClusterAutoscaler(
            ctx.kubeconfig,
            options.clusterAutoscalerVersion,
            options.minNodeCount,
            options.nodeCount
        )
    }
}
