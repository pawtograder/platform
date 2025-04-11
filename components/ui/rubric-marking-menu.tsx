'use client';
import { CheckOption, GroupedRubricOptions } from "./code-file";
import { Menu, MenuItem, SubMenu } from "@jon-bell/react-radial-menu";
export function RubricMarkingMenu({ checks,top, left, setSelectedOption, setCurrentMode }: { checks: GroupedRubricOptions[], top: number, left: number, setSelectedOption: (option: CheckOption | null) => void, setCurrentMode: (mode: "marking" | "select") => void }) {
     // You can also use separate handler for each item
     const handleItemClick = (event: React.MouseEvent<SVGGElement, MouseEvent>, index: number, data?: CheckOption) => {
        setSelectedOption(data!);
        setCurrentMode("select");
    };
    const handleSubMenuClick = (event: React.MouseEvent<SVGGElement, MouseEvent>, index: number, data?: string) => {
        console.log(`[SubMenu] ${data} clicked`);
    };
    const handleDisplayClick = (event: React.MouseEvent<SVGGElement, MouseEvent>, position: string) => {
        console.log(`[Display] ${position} clicked`);
    };

    return <Menu
        centerX={left}
        centerY={top}
        innerRadius={75}
        outerRadius={100}
        show={true}
        hoverToOpen={true}
        hoverToBackTimeout={300}
        animation={["fade", "scale"]}
        animationTimeout={150}
        drawBackground>
        {checks.filter(check => check.options.length > 1).map((check) => (
            <SubMenu key={check.value}
            onItemClick={handleItemClick} onDisplayClick={handleDisplayClick} itemView={check.label} data={check} displayPosition="bottom">
                {check.options.map((option) => (
                    <MenuItem key={option.value} onItemClick={handleItemClick} data={option}>
                        {option.label}
                    </MenuItem>
                ))}
            </SubMenu>
        ))}
        {checks.filter(check => check.options.length === 1).map((check) => (
            <MenuItem key={check.value} onItemClick={handleItemClick} data={check.options[0]}>
                {check.label}
            </MenuItem>
        ))}
    </Menu>
}