import { ResponsiveTable, Table, Badge, Box } from "@pawtograder/webapp";

export const Gradebook = () => (
  <Box maxW="2xl">
    <ResponsiveTable>
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeader>Student</Table.ColumnHeader>
          <Table.ColumnHeader>Assignment</Table.ColumnHeader>
          <Table.ColumnHeader textAlign="end">Score</Table.ColumnHeader>
          <Table.ColumnHeader>Status</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        <Table.Row>
          <Table.Cell>Ava Thompson</Table.Cell>
          <Table.Cell>PS4: Binary Search Trees</Table.Cell>
          <Table.Cell textAlign="end">92 / 100</Table.Cell>
          <Table.Cell>
            <Badge colorPalette="green">Graded</Badge>
          </Table.Cell>
        </Table.Row>
        <Table.Row>
          <Table.Cell>Marcus Lee</Table.Cell>
          <Table.Cell>PS4: Binary Search Trees</Table.Cell>
          <Table.Cell textAlign="end">—</Table.Cell>
          <Table.Cell>
            <Badge colorPalette="yellow">Grading</Badge>
          </Table.Cell>
        </Table.Row>
        <Table.Row>
          <Table.Cell>Priya Nair</Table.Cell>
          <Table.Cell>PS4: Binary Search Trees</Table.Cell>
          <Table.Cell textAlign="end">78 / 100</Table.Cell>
          <Table.Cell>
            <Badge colorPalette="orange">Late</Badge>
          </Table.Cell>
        </Table.Row>
        <Table.Row>
          <Table.Cell>Diego Ramirez</Table.Cell>
          <Table.Cell>PS4: Binary Search Trees</Table.Cell>
          <Table.Cell textAlign="end">0 / 100</Table.Cell>
          <Table.Cell>
            <Badge colorPalette="red">Missing</Badge>
          </Table.Cell>
        </Table.Row>
      </Table.Body>
    </ResponsiveTable>
  </Box>
);

export const Striped = () => (
  <Box maxW="2xl">
    <ResponsiveTable rootProps={{ striped: true, interactive: true }}>
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeader>Submission</Table.ColumnHeader>
          <Table.ColumnHeader>Commit</Table.ColumnHeader>
          <Table.ColumnHeader textAlign="end">Tests</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        <Table.Row>
          <Table.Cell>#1024</Table.Cell>
          <Table.Cell>a1b9f3c</Table.Cell>
          <Table.Cell textAlign="end">24 / 24</Table.Cell>
        </Table.Row>
        <Table.Row>
          <Table.Cell>#1019</Table.Cell>
          <Table.Cell>7d2e110</Table.Cell>
          <Table.Cell textAlign="end">21 / 24</Table.Cell>
        </Table.Row>
        <Table.Row>
          <Table.Cell>#1003</Table.Cell>
          <Table.Cell>c44ab02</Table.Cell>
          <Table.Cell textAlign="end">19 / 24</Table.Cell>
        </Table.Row>
      </Table.Body>
    </ResponsiveTable>
  </Box>
);

export const Scrollable = () => (
  <Box maxW="md">
    <ResponsiveTable tableMinW="48rem">
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeader>Student</Table.ColumnHeader>
          <Table.ColumnHeader>Email</Table.ColumnHeader>
          <Table.ColumnHeader>Section</Table.ColumnHeader>
          <Table.ColumnHeader>GitHub</Table.ColumnHeader>
          <Table.ColumnHeader textAlign="end">Average</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        <Table.Row>
          <Table.Cell>Ava Thompson</Table.Cell>
          <Table.Cell>thompson.a@northeastern.edu</Table.Cell>
          <Table.Cell>L05</Table.Cell>
          <Table.Cell>@avathompson</Table.Cell>
          <Table.Cell textAlign="end">91%</Table.Cell>
        </Table.Row>
        <Table.Row>
          <Table.Cell>Marcus Lee</Table.Cell>
          <Table.Cell>lee.mar@northeastern.edu</Table.Cell>
          <Table.Cell>L08</Table.Cell>
          <Table.Cell>@marcuslee</Table.Cell>
          <Table.Cell textAlign="end">84%</Table.Cell>
        </Table.Row>
      </Table.Body>
    </ResponsiveTable>
  </Box>
);
