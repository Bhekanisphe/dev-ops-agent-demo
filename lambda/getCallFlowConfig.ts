import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';





export const handler = async () => {
    const dynamodb = new DynamoDBClient({ region: process.env.REGION });

    const input = {
        TableName: process.env.CALL_FLOW_CONFIG_TABLE_NAME as string,
        Key: {
            [process.env.CALL_FLOW_CONFIG_KEY_NAME as string]: { S: process.env.CALL_FLOW_CONFIG_KEY_VALUE as string }
        }
    };
    const result = await dynamodb.send(new GetItemCommand(input));
    const item = result.Item
    if (!item) {
        throw new Error(`No item found in table ${process.env.CALL_FLOW_CONFIG_TABLE_NAME} with key ${process.env.CALL_FLOW_CONFIG_KEY_NAME}=${process.env.CALL_FLOW_CONFIG_KEY_VALUE}`);
    }
    const response = {
      statusCode: 200,
      agentWording: item.agentWording.S,
      isInHoursEmergency: item.isInHoursEmergency.BOOL,
      inHourEmergencyMessage: item.inHourEmergencyMessage.S,
      isOutOfHoursEmergency: item.isOutOfHoursEmergency.BOOL,
      dicommisioned: item.dicommisioned.BOOL,
      outOfHourEmergencyMessage: item.outOfHourEmergencyMessage.S,
    };
    return response;
  }