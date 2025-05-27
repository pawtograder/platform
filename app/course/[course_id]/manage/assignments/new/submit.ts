import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const data = req.body;
  // eslint-disable-next-line no-console
  const id = console.log(data);
  res.status(200).json({ id });
}
