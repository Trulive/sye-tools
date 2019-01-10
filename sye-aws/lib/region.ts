import * as aws from 'aws-sdk'
import * as dbg from 'debug'
import { tagResource } from './common'
import { cidrSubset6 } from './cidr'
import { getResources } from './cluster'
import { awaitAsyncCondition, sleep, consoleLog } from '../../lib/common'

const debug = dbg('region')

type SecurityGroups = Map<string, string>
interface Subnet {
    id: string
    name: string
    ipv6CidrBlock?: string
}
interface CoreRegion {
    ec2: aws.EC2
    location: string
    vpcId: string
    subnets: Subnet[]
    securityGroups: SecurityGroups
}

async function createVPC(ec2: aws.EC2, clusterId: string, cidrBlock: string) {
    debug('createVPC', clusterId)
    let vpc = (await ec2
        .createVpc({
            CidrBlock: cidrBlock,
            AmazonProvidedIpv6CidrBlock: true,
        })
        .promise()).Vpc

    await ec2
        .modifyVpcAttribute({
            EnableDnsHostnames: {
                Value: true,
            },
            VpcId: vpc.VpcId,
        })
        .promise()

    while (vpc.Ipv6CidrBlockAssociationSet[0].Ipv6CidrBlockState.State !== 'associated') {
        await sleep(2000)
        let result2 = await ec2
            .describeVpcs({
                VpcIds: [vpc.VpcId],
            })
            .promise()
        vpc = result2.Vpcs[0]
    }

    await ec2.waitFor('vpcAvailable', { VpcIds: [vpc.VpcId] }).promise()

    await tagResource(ec2, vpc.VpcId, clusterId, clusterId)

    return vpc
}

async function getAvailabilityZones(ec2: aws.EC2) {
    let availabilityZones = await ec2.describeAvailabilityZones().promise()
    return availabilityZones.AvailabilityZones.map((az) => az.ZoneName.slice(-1))
}

async function createSubnet(
    ec2: aws.EC2,
    clusterId: string,
    name: string,
    vpcid: string,
    availabilityZone: string,
    ipv4CidrBlock: string,
    ipv6CidrBlock: string,
    routeTableId: string
): Promise<Subnet> {
    debug('createSubnet', name, ipv4CidrBlock, ipv6CidrBlock)
    let subnet = (await ec2
        .createSubnet({
            VpcId: vpcid,
            CidrBlock: ipv4CidrBlock,
            Ipv6CidrBlock: ipv6CidrBlock,
            AvailabilityZone: availabilityZone,
        })
        .promise()).Subnet

    await ec2.waitFor('subnetAvailable', { SubnetIds: [subnet.SubnetId] }).promise()

    await ec2
        .modifySubnetAttribute({
            SubnetId: subnet.SubnetId,
            MapPublicIpOnLaunch: { Value: true },
        })
        .promise()
    await ec2
        .associateRouteTable({
            SubnetId: subnet.SubnetId,
            RouteTableId: routeTableId,
        })
        .promise()

    await tagResource(ec2, subnet.SubnetId, clusterId, name)

    return { id: subnet.SubnetId, name, ipv6CidrBlock }
}

async function createInternetGateway(ec2: aws.EC2, clusterId: string, name: string, vpcid: string) {
    debug('createInternetGateway', name, vpcid)
    let result = await ec2.createInternetGateway().promise()

    await ec2
        .attachInternetGateway({
            VpcId: vpcid,
            InternetGatewayId: result.InternetGateway.InternetGatewayId,
        })
        .promise()

    await tagResource(ec2, result.InternetGateway.InternetGatewayId, clusterId, name)

    return result.InternetGateway.InternetGatewayId
}

async function setupRouteTable(ec2: aws.EC2, clusterId: string, vpcid: string, gatewayid: string) {
    debug('setupRouting', vpcid)
    let routeTableId = (await ec2
        .createRouteTable({
            VpcId: vpcid,
        })
        .promise()).RouteTable.RouteTableId

    await ec2
        .createRoute({
            RouteTableId: routeTableId,
            DestinationCidrBlock: '0.0.0.0/0',
            GatewayId: gatewayid,
        })
        .promise()
    await ec2
        .createRoute({
            RouteTableId: routeTableId,
            DestinationIpv6CidrBlock: '::/0',
            GatewayId: gatewayid,
        })
        .promise()

    await tagResource(ec2, routeTableId, clusterId, 'sye-cluster-route-table')

    return routeTableId
}

async function createSecurityGroups(ec2: aws.EC2, clusterId: string, vpcid: string) {
    debug('createSecurityGroups', vpcid)

    await Promise.all([
        createSecurityGroup(ec2, clusterId, vpcid, 'sye-default', [
            {
                IpProtocol: 'tcp',
                FromPort: 22,
                ToPort: 22,
                IpRanges: [{ CidrIp: '0.0.0.0/0' }],
            },
        ]),
        createSecurityGroup(ec2, clusterId, vpcid, 'sye-egress-pitcher', [
            {
                IpProtocol: 'udp',
                FromPort: 2123,
                ToPort: 2123,
                IpRanges: [{ CidrIp: '0.0.0.0/0' }],
            },
        ]),
        createSecurityGroup(ec2, clusterId, vpcid, 'sye-frontend-balancer', [
            {
                IpProtocol: 'tcp',
                FromPort: 80,
                ToPort: 80,
                IpRanges: [{ CidrIp: '0.0.0.0/0' }],
            },
            {
                IpProtocol: 'tcp',
                FromPort: 443,
                ToPort: 443,
                IpRanges: [{ CidrIp: '0.0.0.0/0' }],
            },
        ]),
        createSecurityGroup(ec2, clusterId, vpcid, 'sye-playout-management', [
            {
                IpProtocol: 'tcp',
                FromPort: 81,
                ToPort: 81,
                IpRanges: [{ CidrIp: '0.0.0.0/0' }],
            },
            {
                IpProtocol: 'tcp',
                FromPort: 4433,
                ToPort: 4433,
                IpRanges: [{ CidrIp: '0.0.0.0/0' }],
            },
        ]),
        createSecurityGroup(ec2, clusterId, vpcid, 'sye-connect-broker', [
            {
                IpProtocol: 'tcp',
                FromPort: 2505,
                ToPort: 2505,
                IpRanges: [{ CidrIp: '0.0.0.0/0' }],
            },
        ]),
    ])
}

async function createSecurityGroup(
    ec2: aws.EC2,
    clusterId: string,
    vpcid: string,
    groupName: string,
    ipPermissions: aws.EC2.IpPermissionList
) {
    debug('createSecurityGroup', groupName)
    const securityGroup = await ec2
        .createSecurityGroup({
            VpcId: vpcid,
            GroupName: groupName,
            Description: groupName.replace(/^sye-/, ''),
        })
        .promise()

    await ec2
        .authorizeSecurityGroupIngress({
            GroupId: securityGroup.GroupId,
            IpPermissions: ipPermissions,
        })
        .promise()

    await tagResource(ec2, securityGroup.GroupId, clusterId, groupName)
}

async function getCoreRegion(clusterId: string): Promise<CoreRegion | undefined> {
    debug('getCoreRegion')
    let resources = await getResources(clusterId, ['ec2:subnet'])
    let ec2: aws.EC2
    let vpcId: string
    let location: string
    let subnets = await Promise.all<Subnet>(
        resources
            .filter((r) => r.Tags.some((tag) => tag.Key === `SyeCore_${clusterId}`))
            .map(
                async (r): Promise<Subnet> => {
                    location = r.ResourceARN.split(':')[3]
                    ec2 = new aws.EC2({ region: location })
                    let id = r.ResourceARN.split('/')[1]
                    let name = r.Tags.find((tag) => tag.Key === 'Name').Value
                    let availabilityZone = name.split('-').pop()
                    let subnet = await getSubnet(ec2, clusterId, availabilityZone)
                    vpcId = subnet.VpcId
                    let ipv6CidrBlock = subnet.Ipv6CidrBlockAssociationSet[0].Ipv6CidrBlock
                    return { id, name, ipv6CidrBlock }
                }
            )
    )
    if (subnets.length > 0) {
        const securityGroups = await getSecurityGroups(ec2, clusterId, vpcId)
        const coreRegion = { ec2, location, vpcId, subnets, securityGroups }
        debug('core region ', coreRegion)
        return coreRegion
    } else {
        return undefined
    }
}

async function isCoreRegion(clusterId: string, region: string): Promise<boolean> {
    let resources = await getResources(clusterId, ['ec2:subnet'])
    return resources
        .filter((r) => r.Tags.some((tag) => tag.Key === `SyeCore_${clusterId}`))
        .some((r) => {
            const coreRegion = r.ResourceARN.split(':')[3]
            return coreRegion === region
        })
}

async function ensureCoreRegion(ec2: aws.EC2, clusterId: string, subnets: Subnet[]) {
    debug('ensureCoreRegion')
    let coreRegion = await getCoreRegion(clusterId)
    if (coreRegion) {
        debug('core region already exists')
        return coreRegion
    } else {
        debug('tag core region')
        let extraTags = {}
        extraTags[`SyeCore_${clusterId}`] = ''
        await Promise.all(subnets.map((subnet) => tagResource(ec2, subnet.id, clusterId, subnet.name, extraTags)))
        return getCoreRegion(clusterId)
    }
}

export async function getVpcs(ec2: aws.EC2, clusterId: string) {
    let result = await ec2
        .describeVpcs({
            Filters: [
                {
                    Name: 'tag-key',
                    Values: [`SyeCluster_${clusterId}`],
                },
            ],
        })
        .promise()
    if (result.Vpcs.length === 0) {
        throw new Error(`No VPCs found for cluster ${clusterId}`)
    } else if (result.Vpcs.length > 1) {
        debug(`WARNING: Expected 1 vpc, but found ${result.Vpcs.length}`)
    }
    return result.Vpcs
}

export async function getSubnet(ec2: aws.EC2, clusterId: string, availabilityZone: string) {
    let result = await ec2
        .describeSubnets({
            Filters: [
                {
                    Name: 'tag:Name',
                    Values: [clusterId + '-' + availabilityZone],
                },
            ],
        })
        .promise()

    if (result.Subnets.length === 1) {
        return result.Subnets[0]
    } else {
        throw `Expected 1 subnet, found ${result.Subnets.length}`
    }
}

export async function getSecurityGroups(ec2: aws.EC2, clusterId: string, vpcid: string) {
    let result = await ec2
        .describeSecurityGroups({
            Filters: [
                {
                    Name: 'tag:SyeClusterId',
                    Values: [clusterId],
                },
                {
                    Name: 'vpc-id',
                    Values: [vpcid],
                },
            ],
        })
        .promise()

    let sgIds: SecurityGroups = new Map()
    result.SecurityGroups.forEach((sg) => sgIds.set(sg.GroupName, sg.GroupId))
    return sgIds
}

// Update security group firewall rule to allow inbound IPv6 traffic
async function allowInboundIPv6Traffic(ec2: aws.EC2, clusterId: string, groupName: string, subnets: Subnet[]) {
    debug('allowInboundIPv6Traffic')
    const vpc = (await getVpcs(ec2, clusterId))[0]
    const securityGroups = await getSecurityGroups(ec2, clusterId, vpc.VpcId)
    await Promise.all(
        subnets.map((subnet) => {
            debug('authorizeSecurityGroupRule', subnet.name)
            return ec2
                .authorizeSecurityGroupIngress({
                    GroupId: securityGroups.get(groupName),
                    IpPermissions: [
                        {
                            IpProtocol: '-1',
                            Ipv6Ranges: [{ CidrIpv6: subnet.ipv6CidrBlock }],
                        },
                    ],
                })
                .promise()
        })
    )
}

export async function regionAdd(clusterId: string, region: string) {
    const ec2 = new aws.EC2({ region })

    let availabilityZones = await getAvailabilityZones(ec2)
    let vpc = await createVPC(ec2, clusterId, '10.0.0.0/16')
    let internetGatewayId = await createInternetGateway(ec2, clusterId, clusterId, vpc.VpcId)
    let routeTableId = await setupRouteTable(ec2, clusterId, vpc.VpcId, internetGatewayId)
    let ipv6blockVpc = vpc.Ipv6CidrBlockAssociationSet[0].Ipv6CidrBlock
    consoleLog('Creating subnets in availability-zones ' + availabilityZones.join(', '))
    const subnets = await Promise.all<Subnet>(
        availabilityZones.map((availabilityZone, index) =>
            createSubnet(
                ec2,
                clusterId,
                clusterId + '-' + availabilityZone,
                vpc.VpcId,
                region + availabilityZone,
                '10.0.' + index * 16 + '.0/20',
                cidrSubset6(ipv6blockVpc, index),
                routeTableId
            )
        )
    )

    await createSecurityGroups(ec2, clusterId, vpc.VpcId)

    /*
     * Only allow IPv6 traffic within cluster regions
     * From core region to and from other regions
     */
    let coreRegion = await ensureCoreRegion(ec2, clusterId, subnets)
    let p = [allowInboundIPv6Traffic(coreRegion.ec2, clusterId, 'sye-default', subnets)]
    if (region !== coreRegion.location) {
        p.push(allowInboundIPv6Traffic(ec2, clusterId, 'sye-default', coreRegion.subnets))
    }
    await Promise.all(p)

    if (await efsAvailableInRegion(region)) {
        await createElasticFileSystem(ec2, clusterId, region, subnets)
    } else {
        consoleLog(`EFS not available in region ${region}. /sharedData will not be available.`, true)
    }
}

export async function efsAvailableInRegion(region: string) {
    const efs = new aws.EFS({ region })
    try {
        await efs.describeFileSystems().promise()
        return true
    } catch (e) {
        if (e.code.match(/UnknownEndpoint/)) {
            return false
        }
        throw e
    }
}

export async function getElasticFileSystem(clusterId: string, region: string) {
    const efs = new aws.EFS({ region })
    let result
    try {
        result = (await efs.describeFileSystems().promise()).FileSystems.find((fs) => fs.Name === clusterId)
    } catch (e) {
        if (!e.code.match(/UnknownEndpoint/)) {
            throw e
        }
    }
    if (result) {
        return result
    } else {
        throw 'Expected 1 elastic file system, found 0'
    }
}

async function createElasticFileSystem(ec2: aws.EC2, clusterId: string, region: string, subnets: Subnet[]) {
    debug('createFileSystem')
    const efs = new aws.EFS({ region })
    const vpc = (await getVpcs(ec2, clusterId))[0]
    let securityGroups = await getSecurityGroups(ec2, clusterId, vpc.VpcId)
    // allow inbound traffic from instances assigned to 'sye-egress-pitcher' security group
    await createSecurityGroup(ec2, clusterId, vpc.VpcId, 'efs-mount-target', [
        {
            IpProtocol: 'tcp',
            FromPort: 2049,
            ToPort: 2049,
            UserIdGroupPairs: [
                {
                    GroupId: securityGroups.get('sye-egress-pitcher'),
                },
            ],
        },
    ])
    const fileSystem = await efs.createFileSystem({ CreationToken: clusterId }).promise()
    await efs
        .createTags({
            FileSystemId: fileSystem.FileSystemId,
            Tags: [
                {
                    Key: 'Name',
                    Value: clusterId,
                },
                {
                    Key: 'SyeClusterId',
                    Value: clusterId,
                },
                {
                    Key: 'SyeCluster_' + clusterId,
                    Value: '',
                },
            ],
        })
        .promise()
    try {
        await awaitAsyncCondition(
            async () => {
                let result = await efs.describeFileSystems({ FileSystemId: fileSystem.FileSystemId }).promise()
                return result.FileSystems[0].LifeCycleState.match(/^available$/) !== null
            },
            5000,
            2 * 60 * 1000,
            'elastic file system to be available'
        )
    } catch (e) {
        consoleLog('Failed to create elastic file system', true)
    }

    debug('createMountTargets')
    securityGroups = await getSecurityGroups(ec2, clusterId, vpc.VpcId)
    await Promise.all(
        subnets.map((subnet) => {
            return efs
                .createMountTarget({
                    FileSystemId: fileSystem.FileSystemId,
                    SubnetId: subnet.id,
                    SecurityGroups: [securityGroups.get('efs-mount-target')],
                })
                .promise()
        })
    )
    try {
        await awaitAsyncCondition(
            async () => {
                let result = await efs.describeMountTargets({ FileSystemId: fileSystem.FileSystemId }).promise()
                return result.MountTargets.every((mt) => mt.LifeCycleState.match(/^available$/) !== null)
            },
            5000,
            5 * 60 * 1000,
            'mount targets to be available'
        )
    } catch (e) {
        consoleLog('Failed to create mount targets', true)
    }
}

async function deleteElasticFileSystem(ec2: aws.EC2, clusterId: string, region: string) {
    const efs = new aws.EFS({ region })
    debug('describeElasticFileSystems')
    const fileSystems = await efs.describeFileSystems().promise()
    const fileSystem = fileSystems.FileSystems.find((fs) => fs.Name === clusterId)

    if (fileSystem === undefined) {
        debug('elastic file system does not exist')
        return
    }

    debug('describeMountTargets')
    const mountTargets = await efs.describeMountTargets({ FileSystemId: fileSystem.FileSystemId }).promise()

    if (!mountTargets.MountTargets.length) {
        debug('mount targets do not exist')
    } else {
        debug('deleteMountTargets')
        await Promise.all(
            mountTargets.MountTargets.map((mt) => {
                return efs.deleteMountTarget({ MountTargetId: mt.MountTargetId }).promise()
            })
        )
        try {
            await awaitAsyncCondition(
                async () => {
                    let result = await efs.describeMountTargets({ FileSystemId: fileSystem.FileSystemId }).promise()
                    return result.MountTargets.length === 0
                },
                5000,
                2 * 60 * 1000,
                'waiting for mount targets to be deleted'
            )
        } catch (e) {
            consoleLog('Failed to delete mount targets', true)
        }
    }

    debug('deleteElasticFileSystems')
    await efs.deleteFileSystem({ FileSystemId: fileSystem.FileSystemId }).promise()

    debug('deleteSecurityGroup')
    const vpcs = await getVpcs(ec2, clusterId)
    await Promise.all(
        vpcs.map(async (vpc) => {
            const securityGroups = await getSecurityGroups(ec2, clusterId, vpc.VpcId)
            await ec2.deleteSecurityGroup({ GroupId: securityGroups.get('efs-mount-target') }).promise()
        })
    )
}

export async function regionDelete(clusterId: string, region: string) {
    const ec2 = new aws.EC2({ region })
    const someTag = (tags: aws.EC2.Tag[], key: string, value: string) =>
        tags.some((tag) => tag.Key === key && tag.Value === value)

    if (await efsAvailableInRegion(region)) {
        await deleteElasticFileSystem(ec2, clusterId, region)
    } else {
        consoleLog(`EFS not available in region ${region}. /sharedData will not be available.`, true)
    }

    debug('describeVpcs')
    const clusterVpcs = await getVpcs(ec2, clusterId)

    await Promise.all(
        clusterVpcs.map(async (vpc) => {
            debug(`describeSecurityGroups for ${vpc.VpcId}`)
            const securityGroups = await getSecurityGroups(ec2, clusterId, vpc.VpcId)

            debug(`describeSubnets for ${vpc.VpcId}`)
            const subnets = await ec2.describeSubnets().promise()
            await Promise.all(
                subnets.Subnets.filter((s) => s.VpcId === vpc.VpcId).map(async (s) => {
                    const p = []
                    if ((await isCoreRegion(clusterId, region)) && securityGroups.get('sye-default')) {
                        debug('revokeSecurityGroupRule sye-default IPv6 firewall rule on core region')
                        p.push(
                            ec2
                                .revokeSecurityGroupIngress({
                                    GroupId: securityGroups.get('sye-default'),
                                    IpPermissions: [
                                        {
                                            IpProtocol: '-1',
                                            Ipv6Ranges: [{ CidrIpv6: s.Ipv6CidrBlockAssociationSet[0].Ipv6CidrBlock }],
                                        },
                                    ],
                                })
                                .promise()
                                .catch((err) => {
                                    // The security group rule might have been removed if the securityGroup failed to be
                                    // removed in a previous attempt
                                    if (
                                        !err.message.match(
                                            /.*The specified rule does not exist in this security group.*/
                                        )
                                    ) {
                                        throw err
                                    }
                                })
                        )
                    }
                    debug('deleteSubnet', s.SubnetId, `for ${vpc.VpcId}`)
                    p.push(ec2.deleteSubnet({ SubnetId: s.SubnetId }).promise())
                    return Promise.all(p)
                })
            )

            let deleteSecurityGroupsPromises = []
            for (let [groupName, groupId] of securityGroups) {
                debug('deleteSecurityGroup', groupName)
                deleteSecurityGroupsPromises.push(ec2.deleteSecurityGroup({ GroupId: groupId }).promise())
            }
            await Promise.all(deleteSecurityGroupsPromises)

            debug(`describeInternetGateways for ${vpc.VpcId}`)
            const internetGateways = await ec2.describeInternetGateways().promise()
            await Promise.all(
                internetGateways.InternetGateways.filter((g) => (g.Attachments[0] || {}).VpcId === vpc.VpcId).map(
                    async (g) => {
                        debug('detachInternetGateway', g.InternetGatewayId, vpc.VpcId)
                        await ec2
                            .detachInternetGateway({
                                InternetGatewayId: g.InternetGatewayId,
                                VpcId: vpc.VpcId,
                            })
                            .promise()
                        debug('deleteInternetGateway', g.InternetGatewayId)
                        return ec2.deleteInternetGateway({ InternetGatewayId: g.InternetGatewayId }).promise()
                    }
                )
            )

            debug(`describeRouteTables for ${vpc.VpcId}`)
            const routeTables = await ec2.describeRouteTables().promise()
            await Promise.all(
                routeTables.RouteTables.filter(
                    (r) => r.VpcId === vpc.VpcId && someTag(r.Tags, 'SyeClusterId', clusterId)
                ).map(async (r) => {
                    debug('deleteRouteTable', r.RouteTableId)
                    return ec2.deleteRouteTable({ RouteTableId: r.RouteTableId }).promise()
                })
            )

            debug(`deleteVPC ${vpc.VpcId}`, clusterId)
            await ec2
                .deleteVpc({
                    VpcId: vpc.VpcId,
                })
                .promise()
        })
    )
}
