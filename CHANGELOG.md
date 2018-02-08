# Changelog

All notable changes to this project will be documented in this file.

## [0.9.9] - 2018-01-06

No code changes from 0.9.8. Re-released due to npm problems.

## [0.9.8] - 2018-01-06

- AWS: Create an EFS volume in all regions that support EFS
- AWS: Mount EFS volume into /sharedData in all machines
- AWS: Show private IP address of machines in `sye aws cluster-show`
- AWS: Support for creating ECR repositories, uploading release to them
and using them in a cluster. Requires Sye release r26.2 or later.

## [0.9.7] - 2017-12-13

- Fix single-server installation
- Improve documentation

## [0.9.6] - 2017-12-13

- Allow single-server installations from Docker Hub

## [0.9.5] - 2017-12-01

- Split into several smaller sub-commands
- Support for Amazon ECR Container Registry
- Delete machine by name or instanceId
- Configure machines with role pitcher with sysctl
- Add a "scaling" role for machines
- Use EnableDnsHostnames to make kafka work

## [0.9.4] 2017-10-26

First public release