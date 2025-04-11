'use client';

import { useShow } from "@refinedev/core";
import { RubricWithCriteriaAndChecks } from "@/utils/supabase/DatabaseTypes";
import { useState } from "react";
import { Menu, MenuItem, SubMenu } from "@jon-bell/react-radial-menu";
import { ConsoleLogger } from "amazon-chime-sdk-js";
import { Box } from "@chakra-ui/react";
export default function RubricTest() {
    const rubric = useShow<RubricWithCriteriaAndChecks>({
        resource: "rubrics",
        id: "1",
        meta: {
            select: "*, rubric_criteria(*, rubric_checks(*))"
        }
    });

    const [show, setShow] = useState(false);
    const [position, setPosition] = useState({ x: 0, y: 0 });

    // You can also use separate handler for each item
    const handleItemClick = (event: React.MouseEvent<SVGGElement, MouseEvent>, index: number, data?: string) => {
        console.log(`[MenuItem] ${data} clicked`);
        setShow(false); // you should handle your menu visibility yourself
    };
    const handleSubMenuClick = (event: React.MouseEvent<SVGGElement, MouseEvent>, index: number, data?: string) => {
        console.log(`[SubMenu] ${data} clicked`);
    };
    const handleDisplayClick = (event: React.MouseEvent<SVGGElement, MouseEvent>, position: string) => {
        console.log(`[Display] ${position} clicked`);
    };
    if (rubric.query.isLoading) {
        return <div>Loading...</div>;
    }
    if (rubric.query.error) {
        return <div>Error: {rubric.query.error.message}</div>;
    }
    const criteria = rubric.query.data?.data.rubric_criteria
    console.log(position);
    //Make sure that everything has at least two submenus
    return (
        <Box
            css={{
              
            }}
            // right click event
            onContextMenu={(e) => {
                e.preventDefault();
                setShow(true);
                const offset = e.currentTarget.getBoundingClientRect();
                setPosition({ x: e.clientX + offset.left + window.scrollX, y: e.clientY + offset.top + window.scrollY });
            }}
            onClick={() => setShow(false)}
            style={{ width: "100vw", height: "100vh" }}
        >
            <Menu
                centerX={position.x}
                centerY={position.y}
                innerRadius={75}
                outerRadius={100}
                show={show}
                hoverToOpen={true}
                animation={["fade", "scale"]}
                animationTimeout={150}
                drawBackground
            >
                {criteria.map(criterion => {
                    return <SubMenu
                        key={criterion.id}
                        onDisplayClick={handleDisplayClick}
                        onItemClick={handleSubMenuClick}
                        itemView={criterion.name}
                        data={criterion.name}
                        displayPosition="bottom"
                    >
                        {criterion.rubric_checks.map(check => {
                            return <MenuItem key={check.id} onItemClick={handleItemClick} data={check.name}>
                                {check.name}
                            </MenuItem>
                        })}
                    </SubMenu>
                })}
            </Menu>
        </Box>
    );


    // console.log(rubric.query.data);
    // return <div>Rubric Test</div>;
}