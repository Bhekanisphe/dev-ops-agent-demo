import { Context } from "aws-lambda";

interface ConnectLambdaEvent {
    Name: string;
    Details: {
        Parameters: Record<string, string>;
        ContactData: {
            Attributes: Record<string, string>;
        };
    };
}

type ConnectLambdaResponse = Record<string, string>;

export const handler = async (
    event: ConnectLambdaEvent,
    context: Context
): Promise<ConnectLambdaResponse> => {
    const refNumber = event.Details.Parameters["ref-number"];

    if (!refNumber) {
        return { statusCode: "400", message: "Missing ref-number parameter" };
    }

    if (refNumber !== "24680") {
        return { statusCode: "400", message: `Invalid ref-number: ${refNumber}` };
    }

    return {
        statusCode: "200",
        message: `Valid ref-number: ${refNumber}`,
        auth_number: "AUTH123456"
    };
};