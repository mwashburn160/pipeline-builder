import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    let resp: APIGatewayProxyResult;
    try {
        resp = {
            statusCode: 200,
            body: JSON.stringify({
                message: 'hello SAM',
            }),
        };
    } catch (error) {
        console.log(error);
        resp = {
            statusCode: 500,
            body: JSON.stringify({
                message: 'some error happened',
            }),
        };
    }
    return resp
  }