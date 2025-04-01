import { Duration } from 'aws-cdk-lib';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';


export class Constants {
  static readonly NODEJS_VERSION = Runtime.NODEJS_20_X;

  static readonly DEFAULT_TIMEOUT = Duration.seconds(900);
  static readonly DEFAULT_MEMORY_SIZE = 4;
  static readonly DEFAULT_LOG_RETENTION = RetentionDays.ONE_DAY;
  static readonly DEFAULT_SYNTH_PLUGIN_NAME = 'synth';
  static readonly DEFAULT_ARCHITECTURE = Architecture.ARM_64
}