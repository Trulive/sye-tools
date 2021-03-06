import { AzureSession } from '../../lib/azure/azure-session'
import { getAksServicePrincipalName } from './aks-config'

export async function aksRegionPrepare(
    subscriptionNameOrId: string | undefined,
    options: {
        resourceGroup: string
        location: string
        cidr: string
        password: string
    }
) {
    const azureSession = await new AzureSession().init({ subscriptionNameOrId })
    await azureSession.createResourceGroup(options.resourceGroup, options.location)
    await azureSession.createVnet(options.resourceGroup, options.resourceGroup, options.location, options.cidr)
    const adApplication = await azureSession.createAdApplication(getAksServicePrincipalName(options.resourceGroup))
    const servicePrincipal = await azureSession.createServicePrincipal(
        getAksServicePrincipalName(options.resourceGroup),
        options.password,
        adApplication
    )

    // Contributor access to the main resource group
    await azureSession.assignRoleToServicePrincipal(
        servicePrincipal,
        azureSession.getResourceGroupScope(options.resourceGroup),
        azureSession.getRoleDefinitionId(azureSession.CONTRIBUTOR_ROLE_NAME)
    )
}
