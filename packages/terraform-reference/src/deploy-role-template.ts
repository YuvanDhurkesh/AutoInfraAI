/**
 * CloudFormation template for the cross-account role AutoInfra assumes in a
 * user's AWS account (Sec. 3.1). Lives in terraform-reference since it's
 * "house-style" reference infrastructure, not Terraform itself (CloudFormation
 * is used here specifically because it's a one-time bootstrap the user runs
 * themselves, before any Terraform state bucket exists).
 *
 * Scoped to: EC2/VPC (read + the subset needed to create the F1/F2 patterns),
 * S3, CloudFront, Lambda, DynamoDB, IAM limited to autoinfra-* roles/policies,
 * SSM Parameter Store under /autoinfra/* + Run Command, ECR, CodeBuild,
 * CloudWatch Logs, RDS (optional, for F2+RDS), Resource Groups Tagging (read),
 * freetier:Get*, a narrow budgets:* grant, sts:GetCallerIdentity. An explicit
 * deny blocks IAM writes outside autoinfra-*, Organizations, and Account
 * actions, as a safety net against privilege escalation even if a future
 * change accidentally widens one of the allow statements above it.
 */
/**
 * Bump whenever the role's permissions change. The stack reports it back on
 * create/update, so AutoInfra can tell a connection still on an older role
 * to update its stack.
 *   1 -- initial (no version reported)
 *   2 -- EC2 prefix-list/defaults reads, ECR repository settings
 *   3 -- s3:DeleteObjectVersion (Destroy empties versioned buckets)
 */
export const DEPLOY_ROLE_TEMPLATE_VERSION = 3;

export interface DeployRoleTemplateOptions {
  /** Pre-filled for the downloadable copy; the quick-create link passes it as a parameter instead. */
  externalId?: string;
  connectionId?: string;
  /** Platform SNS topic for the custom-resource callback (must be in the stack's region). */
  registrationTopicArn?: string;
}

export function buildDeployRoleTemplate(
  platformAccountId: string,
  opts: DeployRoleTemplateOptions = {},
): string {
  const defaults = (v?: string) => (v ? `\n    Default: "${v}"` : "");
  // The callback tells AutoInfra the role exists, so the user never pastes an
  // ARN. If AutoInfra can't verify the role, the stack rolls back with the reason.
  const registration = opts.registrationTopicArn
    ? `
  AutoInfraRegistration:
    Type: Custom::AutoInfraRegistration
    Properties:
      ServiceToken: "${opts.registrationTopicArn}"
      ConnectionId: !Ref ConnectionId
      ExternalId: !Ref ExternalId
      RoleArn: !GetAtt AutoInfraDeployRole.Arn
      TemplateVersion: "${DEPLOY_ROLE_TEMPLATE_VERSION}"
`
    : "";
  return `AWSTemplateFormatVersion: "2010-09-09"
Description: >
  AutoInfra cross-account deploy role. Grants AutoInfra's platform account
  permission to provision Free-Tier-eligible AWS infrastructure in this
  account on your behalf, scoped to resources it creates and tags itself.
  See the AutoInfra README for what this role can and cannot do.

Parameters:
  ExternalId:
    Type: String
    NoEcho: true${defaults(opts.externalId)}
    Description: >
      Unique per-connection secret AutoInfra generated for you. Do not share
      it; it prevents other AutoInfra customers from assuming this role.
  ConnectionId:
    Type: String${defaults(opts.connectionId)}
    Description: Which AutoInfra connection this role belongs to.
  RoleName:
    Type: String
    Default: AutoInfraDeployRole

Resources:${registration}
  AutoInfraDeployRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Ref RoleName
      MaxSessionDuration: 3600
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal:
              AWS: "arn:aws:iam::${platformAccountId}:root"
            Action: sts:AssumeRole
            Condition:
              StringEquals:
                sts:ExternalId: !Ref ExternalId
      Policies:
        - PolicyName: AutoInfraDeployPolicy
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Sid: Identity
                Effect: Allow
                Action:
                  - sts:GetCallerIdentity
                  - freetier:Get*
                Resource: "*"
              - Sid: BudgetsNarrow
                Effect: Allow
                Action:
                  - budgets:DescribeBudgets
                  - budgets:CreateBudget
                  - budgets:DescribeBudgetNotificationsForAccount
                Resource: "*"
              - Sid: TaggingRead
                Effect: Allow
                Action:
                  - tag:GetResources
                  - tag:GetTagKeys
                  - tag:GetTagValues
                Resource: "*"
              # Terraform refreshes every managed resource on each plan, which
              # needs many read-only calls. Get/List/Describe only -- no writes.
              - Sid: ReadOnlyForTerraformRefresh
                Effect: Allow
                Action:
                  - s3:Get*
                  - s3:List*
                  - lambda:Get*
                  - lambda:List*
                  - dynamodb:Describe*
                  - dynamodb:List*
                  - cloudfront:Get*
                  - cloudfront:List*
                  - cloudfront:Describe*
                  - iam:Get*
                  - iam:List*
                  - ecr:Describe*
                  - ecr:List*
                  - ecr:Get*
                  - codebuild:BatchGet*
                  - codebuild:List*
                  - logs:Describe*
                  - logs:List*
                  - ssm:Describe*
                  - ssm:List*
                  - rds:Describe*
                  - rds:List*
                Resource: "*"
              # AWS-published public parameters, e.g. the latest Amazon Linux AMI id.
              - Sid: PublicSsmParameters
                Effect: Allow
                Action:
                  - ssm:GetParameter
                  - ssm:GetParameters
                Resource: "arn:aws:ssm:*::parameter/aws/service/*"
              - Sid: Ec2AndVpc
                Effect: Allow
                Action:
                  - ec2:Describe*
                  # Read-only: the CloudFront origin-facing prefix list (F2's
                  # security group) and account EC2 defaults Terraform reads.
                  - ec2:GetManagedPrefixListEntries
                  - ec2:GetManagedPrefixListAssociations
                  - ec2:GetEbsEncryptionByDefault
                  - ec2:GetInstanceMetadataDefaults
                  - ec2:RunInstances
                  - ec2:TerminateInstances
                  - ec2:StopInstances
                  - ec2:StartInstances
                  - ec2:CreateTags
                  - ec2:ModifyVpcAttribute
                  - ec2:ModifySubnetAttribute
                  - ec2:ModifyInstanceAttribute
                  - ec2:ModifyInstanceMetadataOptions
                  - ec2:DeleteTags
                  - ec2:CreateVpc
                  - ec2:DeleteVpc
                  - ec2:CreateSubnet
                  - ec2:DeleteSubnet
                  - ec2:CreateSecurityGroup
                  - ec2:DeleteSecurityGroup
                  - ec2:AuthorizeSecurityGroupIngress
                  - ec2:AuthorizeSecurityGroupEgress
                  - ec2:RevokeSecurityGroupIngress
                  - ec2:RevokeSecurityGroupEgress
                  - ec2:CreateInternetGateway
                  - ec2:DeleteInternetGateway
                  - ec2:AttachInternetGateway
                  - ec2:DetachInternetGateway
                  - ec2:CreateRouteTable
                  - ec2:DeleteRouteTable
                  - ec2:CreateRoute
                  - ec2:DeleteRoute
                  - ec2:AssociateRouteTable
                  - ec2:DisassociateRouteTable
                  - ec2:CreateVolume
                  - ec2:DeleteVolume
                  - ec2:AttachVolume
                  - ec2:DetachVolume
                  - ec2:AllocateAddress
                  - ec2:ReleaseAddress
                  - ec2:AssociateAddress
                  - ec2:DisassociateAddress
                Resource: "*"
              - Sid: S3
                Effect: Allow
                Action:
                  - s3:CreateBucket
                  - s3:DeleteBucket
                  - s3:PutBucketPolicy
                  - s3:DeleteBucketPolicy
                  - s3:PutBucketVersioning
                  - s3:PutEncryptionConfiguration
                  - s3:PutBucketPublicAccessBlock
                  - s3:PutLifecycleConfiguration
                  - s3:PutBucketTagging
                  - s3:GetObject
                  - s3:PutObject
                  - s3:DeleteObject
                  # Destroy empties versioned buckets (the build artifacts bucket).
                  - s3:DeleteObjectVersion
                  - s3:ListBucket
                  - s3:GetBucketLocation
                  - s3:GetBucketVersioning
                  - s3:GetEncryptionConfiguration
                Resource: "*"
              - Sid: CloudFront
                Effect: Allow
                Action:
                  - cloudfront:CreateDistribution
                  - cloudfront:UpdateDistribution
                  - cloudfront:DeleteDistribution
                  - cloudfront:GetDistribution*
                  - cloudfront:ListDistributions
                  - cloudfront:TagResource
                  - cloudfront:CreateInvalidation
                  - cloudfront:UpdateOriginAccessControl
                  - cloudfront:UntagResource
                  - cloudfront:CreateFunction
                  - cloudfront:UpdateFunction
                  - cloudfront:PublishFunction
                  - cloudfront:DeleteFunction
                  - cloudfront:CreateOriginAccessControl
                  - cloudfront:DeleteOriginAccessControl
                  - cloudfront:GetOriginAccessControl
                Resource: "*"
              - Sid: Lambda
                Effect: Allow
                Action:
                  - lambda:CreateFunction
                  - lambda:UpdateFunctionCode
                  - lambda:UpdateFunctionConfiguration
                  - lambda:DeleteFunction
                  - lambda:GetFunction*
                  - lambda:ListVersionsByFunction
                  - lambda:PublishVersion
                  - lambda:CreateAlias
                  - lambda:UpdateAlias
                  - lambda:CreateFunctionUrlConfig
                  - lambda:UpdateFunctionUrlConfig
                  - lambda:DeleteFunctionUrlConfig
                  - lambda:GetFunctionUrlConfig
                  - lambda:AddPermission
                  - lambda:RemovePermission
                  - lambda:TagResource
                  - lambda:UntagResource
                Resource: "*"
              - Sid: DynamoDb
                Effect: Allow
                Action:
                  - dynamodb:CreateTable
                  - dynamodb:DeleteTable
                  - dynamodb:DescribeTable
                  - dynamodb:UpdateTable
                  - dynamodb:TagResource
                  - dynamodb:UntagResource
                  - dynamodb:UpdateContinuousBackups
                  - dynamodb:UpdateTimeToLive
                  - dynamodb:ListTagsOfResource
                Resource: "*"
              - Sid: IamAutoInfraScoped
                Effect: Allow
                Action:
                  - iam:CreateRole
                  - iam:DeleteRole
                  - iam:GetRole
                  - iam:PutRolePolicy
                  - iam:DeleteRolePolicy
                  - iam:GetRolePolicy
                  - iam:AttachRolePolicy
                  - iam:DetachRolePolicy
                  - iam:PassRole
                  - iam:TagRole
                  - iam:UntagRole
                  - iam:TagInstanceProfile
                  - iam:UntagInstanceProfile
                  - iam:UpdateAssumeRolePolicy
                  - iam:CreateInstanceProfile
                  - iam:DeleteInstanceProfile
                  - iam:AddRoleToInstanceProfile
                  - iam:RemoveRoleFromInstanceProfile
                Resource:
                  - "arn:aws:iam::*:role/autoinfra-*"
                  - "arn:aws:iam::*:instance-profile/autoinfra-*"
              - Sid: Ssm
                Effect: Allow
                Action:
                  - ssm:PutParameter
                  - ssm:GetParameter
                  - ssm:GetParameters
                  - ssm:GetParametersByPath
                  - ssm:DeleteParameter
                  - ssm:AddTagsToResource
                  - ssm:RemoveTagsFromResource
                Resource: "arn:aws:ssm:*:*:parameter/autoinfra/*"
              - Sid: SsmRunCommand
                Effect: Allow
                Action:
                  - ssm:SendCommand
                  - ssm:GetCommandInvocation
                  - ssm:DescribeInstanceInformation
                Resource: "*"
              - Sid: Ecr
                Effect: Allow
                Action:
                  - ecr:CreateRepository
                  - ecr:DeleteRepository
                  - ecr:DescribeRepositories
                  - ecr:PutLifecyclePolicy
                  - ecr:PutImageTagMutability
                  - ecr:PutImageScanningConfiguration
                  - ecr:GetAuthorizationToken
                  - ecr:BatchCheckLayerAvailability
                  - ecr:PutImage
                  - ecr:InitiateLayerUpload
                  - ecr:UploadLayerPart
                  - ecr:CompleteLayerUpload
                  - ecr:BatchGetImage
                  - ecr:ListImages
                  - ecr:TagResource
                  - ecr:UntagResource
                  - ecr:DeleteLifecyclePolicy
                Resource: "*"
              - Sid: CodeBuild
                Effect: Allow
                Action:
                  - codebuild:CreateProject
                  - codebuild:UpdateProject
                  - codebuild:DeleteProject
                  - codebuild:BatchGetProjects
                  - codebuild:StartBuild
                  - codebuild:BatchGetBuilds
                Resource: "*"
              - Sid: Logs
                Effect: Allow
                Action:
                  - logs:CreateLogGroup
                  - logs:DeleteLogGroup
                  - logs:PutRetentionPolicy
                  - logs:DescribeLogGroups
                  - logs:GetLogEvents
                  - logs:FilterLogEvents
                  - logs:TagResource
                  - logs:UntagResource
                  - logs:DeleteRetentionPolicy
                Resource: "*"
              - Sid: RdsOptional
                Effect: Allow
                Action:
                  - rds:CreateDBInstance
                  - rds:DeleteDBInstance
                  - rds:DescribeDBInstances
                  - rds:ModifyDBInstance
                  - rds:AddTagsToResource
                  - rds:CreateDBSubnetGroup
                  - rds:DeleteDBSubnetGroup
                Resource: "*"
              - Sid: DenyEscapeHatches
                Effect: Deny
                Action:
                  - "organizations:*"
                  - "account:*"
                  - "sso:*"
                  - "sso-admin:*"
                  - "identitystore:*"
                  - "iam:CreateUser"
                  - "iam:CreateAccessKey"
                  - "iam:AttachUserPolicy"
                  - "iam:CreateLoginProfile"
                  - "kms:CreateKey"
                  - "secretsmanager:CreateSecret"
                Resource: "*"

Outputs:
  RoleArn:
    Description: Paste this ARN into AutoInfra's AWS connect wizard.
    Value: !GetAtt AutoInfraDeployRole.Arn
  TemplateVersion:
    Description: AutoInfra permission set version of this role.
    Value: "${DEPLOY_ROLE_TEMPLATE_VERSION}"
`;
}
