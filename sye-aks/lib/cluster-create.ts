import { consoleLog } from '../../lib/common'
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
    writeClusterAutoscalerFile,
} from '../../lib/k8s'
import { ensurePublicIps } from './utils'
import { AzureSession, NodePool } from '../../lib/azure/azure-session'
import { promisify } from 'util'
import * as k8s from '@kubernetes/client-node'
import { getK8sResourceGroup } from './aks-config'
import { getVnetName } from './aks-config'
import { getSubnetName } from './aks-config'
import { getAksServicePrincipalName } from './aks-config'
import { defaultClusterAutoscalerSpName } from './aks-config'
import { ServicePrincipal } from 'azure-graph/lib/models'

const debug = require('debug')('aks/cluster-create')

async function addCredentials(
    azureSession: AzureSession,
    servicePrincipal: ServicePrincipal,
    k8sResourceGroup: string,
    resourceGroup: string,
    vnetName: string,
    subnetName: string
) {
    await azureSession.assignRoleToServicePrincipal(
        servicePrincipal,
        azureSession.getResourceGroupScope(k8sResourceGroup),
        azureSession.getRoleDefinitionId(azureSession.CONTRIBUTOR_ROLE_NAME)
    )
    await azureSession.assignRoleToServicePrincipal(
        servicePrincipal,
        azureSession.getSubnetScope(resourceGroup, vnetName, subnetName),
        azureSession.getRoleDefinitionId(azureSession.NETWORK_CONTRIBUTOR_ROLE_NAME)
    )
}

async function downloadKubectlCredentials(
    azureSession: AzureSession,
    kubeconfig: string,
    resourceGroup: string,
    clusterName: string
) {
    consoleLog(`Download kubectl credentials to ${kubeconfig}.`)
    if (fs.existsSync(kubeconfig)) {
        consoleLog('  Deleting old file...')
        await util.promisify(fs.unlink)(kubeconfig)
    }
    consoleLog('  Downloading new file from Azure AKS...')
    const containerServiceClient = azureSession.containerServiceClient()
    const adminCredentials = await containerServiceClient.managedClusters.listClusterAdminCredentials(
        resourceGroup,
        clusterName
    )
    debug('Found credentials', adminCredentials)
    await promisify(fs.writeFile)(kubeconfig, adminCredentials.kubeconfigs[0].value)
    consoleLog('  Done.')
}

async function getClusterAutoscalerExtraValues(
    azureSession: AzureSession,
    kubeconfig: string,
    nodepools: NodePool[],
    spPassword: string,
    autoscalerSpName: string,
    resourceGroup: string,
    clusterName: string,
    k8sResourceGroup: string
) {
    const k8sConfig = new k8s.KubeConfig()
    k8sConfig.loadFromFile(kubeconfig)
    const k8sApi = k8sConfig.makeApiClient(k8s.Core_v1Api)

    const nodeList = (await k8sApi.listNode()).body
    debug('Found nodes', nodeList)
    const agentpool = nodeList.items[0].metadata.labels['agentpool']
    debug('agentpool', agentpool)

    const spId = autoscalerSpName || defaultClusterAutoscalerSpName(resourceGroup, clusterName)
    const sp = await azureSession.getServicePrincipal(spId)

    const values = {
        azureClientID: sp.appId,
        azureClientSecret: spPassword,
        azureSubscriptionID: azureSession.currentSubscription.id,
        azureTenantID: azureSession.currentSubscription.tenantId,
        azureVMType: 'AKS',
        azureClusterName: clusterName,
        azureResourceGroup: resourceGroup,
        azureNodeResourceGroup: k8sResourceGroup,
        autoscalingGroups: [],
    }

    for (const nodepool of nodepools) {
        values.autoscalingGroups.push({
            name: nodepool.name,
            minSize: nodepool.minCount,
            maxSize: nodepool.maxCount,
        })
    }

    return values
}

export async function createAksCluster(
    subscriptionNameOrId: string | undefined,
    options: {
        resourceGroup: string
        location: string
        clusterName: string
        kubernetesVersion: string
        nodepools: NodePool[]
        servicePrincipalPassword: string
        kubeconfig: string
        useVmss: boolean
        subnetCidr: string
        autoscalerValuesFile: string
        autoscalerSpName?: string
        autoscalerSpPassword?: string
        maxPodsPerNode?: number
        openSshPort?: boolean
        publicKeyPath?: string
    }
) {
    const azureSession = await new AzureSession().init({ subscriptionNameOrId })
    const k8sResourceGroup = await getK8sResourceGroup(options.resourceGroup, options.clusterName, options.location)
    await azureSession.createSubnet(
        options.resourceGroup,
        getVnetName(options.resourceGroup),
        getSubnetName(options.clusterName),
        options.subnetCidr
    )
    const servicePrincipalName = getAksServicePrincipalName(options.resourceGroup)
    await azureSession.createCluster(
        options.clusterName,
        options.resourceGroup,
        options.location,
        options.useVmss,
        options.kubernetesVersion,
        options.nodepools,
        options.servicePrincipalPassword,
        options.subnetCidr,
        servicePrincipalName,
        getVnetName(options.resourceGroup),
        getSubnetName(options.clusterName),
        options.publicKeyPath,
        options.maxPodsPerNode
    )
    const servicePrincipal = await azureSession.getServicePrincipal(servicePrincipalName)
    await addCredentials(
        azureSession,
        servicePrincipal,
        k8sResourceGroup,
        options.resourceGroup,
        getVnetName(options.resourceGroup),
        getSubnetName(options.clusterName)
    )
    if (options.useVmss) {
        await azureSession.enableVmssPublicIps(k8sResourceGroup)
    } else {
        await ensurePublicIps(azureSession, options.clusterName, k8sResourceGroup, options.location)
    }
    await azureSession.openPortInNsg(2123, 2130, 'Udp', 200, 'Sye SSP traffic (UDP 2123-2130)', k8sResourceGroup)
    await azureSession.openPortInNsg(2505, 2505, 'Tcp', 202, 'Connect Broker traffic (TCP 2505)', k8sResourceGroup)
    if (options.openSshPort) {
        await azureSession.openPortInNsg(22, 22, 'Tcp', 201, 'SSH access', k8sResourceGroup)
    }
    await downloadKubectlCredentials(azureSession, options.kubeconfig, options.resourceGroup, options.clusterName)
    installTillerRbac(options.kubeconfig)
    installTiller(options.kubeconfig)
    waitForTillerStarted(options.kubeconfig)
    installNginxIngress(options.kubeconfig)
    if (options.autoscalerSpPassword) {
        installPrometheusOperator(options.kubeconfig)
        installPrometheus(options.kubeconfig)
        installPrometheusAdapter(options.kubeconfig)
        writeClusterAutoscalerFile(
            options.autoscalerValuesFile,
            options.kubeconfig,
            'azure',
            await getClusterAutoscalerExtraValues(
                azureSession,
                options.kubeconfig,
                options.nodepools,
                options.autoscalerSpPassword,
                options.autoscalerSpName,
                options.resourceGroup,
                options.clusterName,
                k8sResourceGroup
            )
        )
    }
}
