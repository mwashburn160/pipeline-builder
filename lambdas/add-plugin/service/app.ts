import { APIGatewayProxyEventV2, APIGatewayEventRequestContextV2, APIGatewayProxyResultV2 } from 'aws-lambda';

export const handler = async (event: APIGatewayProxyEventV2, context: APIGatewayEventRequestContextV2): Promise<APIGatewayProxyResultV2> => {
    try {
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'hello world.......',
            }),
        };
    } catch (err) {
        console.log(err);
        return {
            statusCode: 500,
            body: JSON.stringify({
                message: 'some error happened',
            }),
        };
    }
};
